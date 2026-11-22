"""Immutable PG index preparation and Publisher-side adoption checks."""
from collections import defaultdict
from hashlib import sha256
from pathlib import Path
from time import perf_counter

from psycopg.types.json import Jsonb

from ontoweave_publication.store import digest, manifest, projection, ref, require
from ontoweave_retrieval_contracts import INDEX_CONTRACT, RECORD_SCHEMA_VERSION

from . import sources
from .embedding import EmbeddingCache, put_space, validate_space
from .material import RENDER_VERSIONS, binding, materials, text_sha

ROOT = Path(__file__).resolve().parents[2]
BUSINESS_KINDS = ("NODE", "EDGE", "STATEMENT", "SOURCE", "FACT", "DEFINITION", "REVIEW")
REVISION_FIELDS = ("identity_revision", "ontology_revision", "time_revision", "fact_revision")


def migrate(store):
    raw = (ROOT / "migrations/012-retrieval-index-v1.sql").read_bytes()
    pin = sha256(raw).hexdigest()
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-retrieval-index-schema'))")
        existing = q("SELECT to_regclass('retrieval_v1.schema_version') AS version").fetchone()["version"]
        if existing:
            row = q("SELECT sha256 FROM retrieval_v1.schema_version WHERE version=12").fetchone()
            require(row and row["sha256"] == pin, "RETRIEVAL_INDEX_MIGRATION_CHANGED", 503)
        else:
            q(raw.decode())
            q("INSERT INTO retrieval_v1.schema_version VALUES (12,%s)", [pin])
    return dict(version=12, sha256=pin, reused=bool(existing))


def publication_for_view(adopted):
    return dict(library_ref=adopted["library_ref"], source_manifest_ref=adopted["source_manifest_ref"],
                target_revisions={key: adopted[key] for key in REVISION_FIELDS},
                base_view_revision=adopted["view_revision"])


def _prepared(descriptor):
    return dict(index_descriptor_ref=descriptor["index_descriptor_ref"],
                index_revision=descriptor["index_revision"], descriptor_sha256=digest(descriptor))


def read_descriptor(q, library, descriptor_ref):
    row = q("""SELECT body,body_sha,receipt FROM retrieval_v1.indexes
               WHERE library_ref=%s AND index_descriptor_ref=%s""", [library, descriptor_ref]).fetchone()
    require(row and digest(row["body"]) == row["body_sha"], "INDEX_DESCRIPTOR_UNAVAILABLE", 503)
    body = row["body"]
    require(body["index_descriptor_ref"] == descriptor_ref and body["library_ref"] == library
            and body["contract"] == INDEX_CONTRACT and body["preparation_receipt_ref"] == ref("index_preparation", row["receipt"])
            and digest(body["coverage"]) == body["coverage_digest"]
            and ref("retrieval_descriptor", {k: v for k, v in body.items() if k != "index_descriptor_ref"}) == descriptor_ref,
            "INDEX_DESCRIPTOR_DIGEST_MISMATCH", 503)
    return body


def members(q, library, descriptor, *, include_vectors=False):
    rows = q(f"""
        SELECT m.record_version_ref,m.text_sha,m.space_ref,m.profile_ref,m.vector_ref,
               r.body,r.body_sha {",c.embedding::text AS wire" if include_vectors else ""}
        FROM retrieval_v1.memberships m JOIN retrieval_v1.records r
          ON (r.library_ref,r.record_version_ref)=(m.library_ref,m.record_version_ref)
        {'''LEFT JOIN retrieval_v1.embedding_cache c ON
              (c.library_ref,c.space_ref,c.profile_ref,c.text_sha,c.vector_ref) =
              (m.library_ref,m.space_ref,m.profile_ref,m.text_sha,m.vector_ref)''' if include_vectors else ""}
        WHERE m.library_ref=%s AND m.index_revision=%s ORDER BY m.record_version_ref
        """, [library, descriptor["index_revision"]]).fetchall()
    require(digest([_member_identity(row) for row in rows]) == descriptor["membership_digest"],
            "INDEX_MEMBERSHIP_DIGEST_MISMATCH", 503)
    require(all(digest(row["body"]) == row["body_sha"] and row["body"]["text_sha256"] == row["text_sha"]
                and row["body"]["record_version_ref"] == row["record_version_ref"]
                and text_sha(row["body"]["text_for_search"]) == row["text_sha"]
                and row["space_ref"] == descriptor["space_refs"].get(row["body"]["pool"]) for row in rows),
            "INDEX_RECORD_DIGEST_MISMATCH", 503)
    return rows


def _member_identity(row):
    return [row[key] for key in ("record_version_ref", "text_sha", "space_ref", "profile_ref", "vector_ref", "body_sha")]


def validate_prepared(q, publication, graph, prepared):
    library = publication["library_ref"]
    descriptor = read_descriptor(q, library, prepared["index_descriptor_ref"])
    inventory = sources.read(q, library, publication["source_manifest_ref"])
    require(prepared == _prepared(descriptor) and descriptor["base_view_revision"] == publication["base_view_revision"]
            and descriptor["source_manifest_ref"] == publication["source_manifest_ref"]
            and descriptor["target_revisions"] == publication["target_revisions"]
            and descriptor["target_snapshot_digest"] == binding(publication, graph, inventory["body_sha"]),
            "INDEX_PREPARED_BASIS_MISMATCH", 409)
    members(q, library, descriptor)
    return descriptor


def retrieval_gaps(descriptor):
    return [dict(reason_code=gap["code"], scope_ref=gap["object_ref"], component=kind,
                 domain="RETRIEVAL_INDEX") for kind, coverage in descriptor["coverage"].items()
            for gap in coverage["gaps"]]


class IndexRepository:
    def __init__(self, store):
        self.store = store
        self.cache = EmbeddingCache(store)

    def register_source_manifest(self, library_ref, source_manifest_ref, blocks, *, authority):
        with self.store.transaction() as (q, _):
            return sources.register(q, library_ref, source_manifest_ref, blocks, authority)

    def register_saved_source_manifest(self, library_ref, source_manifest_ref, run_ref):
        with self.store.transaction(readonly=True) as (q, _):
            blocks, authority = sources.read_saved(q, library_ref, run_ref)
        return self.register_source_manifest(library_ref, source_manifest_ref, blocks, authority=authority)

    def register_confirmed_sources(self, library_ref, view_revision):
        with self.store.transaction(readonly=True) as (q, _):
            adopted = manifest(q, library_ref, view_revision)
            source_ref = adopted["source_manifest_ref"]
            existing = q("""SELECT 1 FROM retrieval_v1.source_manifests
                            WHERE library_ref=%s AND source_manifest_ref=%s""", [library_ref, source_ref]).fetchone()
            if existing:
                return sources.read(q, library_ref, source_ref)["body_sha"]
            row = q("""
                WITH RECURSIVE lineage AS (
                  SELECT body,parent_view_revision,job_ref,activation_seq FROM publication_v1.manifests
                  WHERE library_ref=%s AND view_revision=%s
                  UNION ALL
                  SELECT parent.body,parent.parent_view_revision,parent.job_ref,parent.activation_seq
                  FROM publication_v1.manifests parent JOIN lineage l ON parent.view_revision=l.parent_view_revision
                  WHERE parent.library_ref=%s
                )
                SELECT j.request->>'run_ref' AS run_ref FROM lineage l JOIN publication_v1.jobs j USING (job_ref)
                WHERE j.library_ref=%s AND l.body->>'source_manifest_ref'=%s AND j.request->>'run_ref' IS NOT NULL
                ORDER BY l.activation_seq DESC LIMIT 1
                """, [library_ref, view_revision, library_ref, library_ref, source_ref]).fetchone()
            require(row, "INDEX_SAVED_SOURCE_RUN_UNAVAILABLE", 422)
        return self.register_saved_source_manifest(library_ref, source_ref, row["run_ref"])

    def prepare_confirmed_index(self, library_ref, view_revision, **options):
        self.register_confirmed_sources(library_ref, view_revision)
        with self.store.transaction(readonly=True) as (q, _):
            adopted = manifest(q, library_ref, view_revision)
            graph = projection(q, library_ref, view_revision, BUSINESS_KINDS)
        prepared = self.prepare_index(publication_for_view(adopted), graph, **options)
        return self.certify_historical(library_ref, view_revision, prepared)

    def prepare_index(self, publication, graph, *, client=None, space=None, segment_codepoints, operation_ref=None):
        started = perf_counter()
        library = publication["library_ref"]
        require(type(segment_codepoints) is int and segment_codepoints > 0, "INDEX_SEGMENT_SIZE_INVALID", 422)
        if client is not None:
            require(space is None or space == client.space, "INDEX_EMBEDDING_SPACE_MISMATCH", 422)
            space = client.space
            segment_codepoints = min(segment_codepoints, getattr(client, "max_input_utf8_bytes", 2**31)//4)
        if space:
            validate_space(space)
        with self.store.transaction(readonly=True) as (q, _):
            inventory = sources.read(q, library, publication["source_manifest_ref"])
        records, expected, gaps = materials(library, graph, inventory["body"]["blocks"], segment_codepoints)
        target_digest = binding(publication, graph, inventory["body_sha"])
        grouped = defaultdict(dict)
        for record in records:
            grouped[record["pool"]][record["text_sha256"]] = record["text_for_search"]
        record_ms = (perf_counter()-started)*1000
        vectors, diagnostics, receipts = {}, {}, {}
        for pool, texts in sorted(grouped.items()):
            if space:
                vectors[pool], diagnostics[pool], receipts[pool] = self.cache.resolve(
                    library, space, space["document_profile_refs"][pool], texts, client=client,
                    operation=operation_ref or (publication.get("request_ref") if client is not None else None))
                if diagnostics[pool]:
                    client = None
        measured = dict(material_ms=record_ms, cache_and_embedding_ms=(perf_counter()-started)*1000-record_ms)
        return self._save(publication, target_digest, records, expected, gaps, space, vectors,
                          diagnostics, receipts, measured, segment_codepoints)

    def _save(self, publication, target_digest, records, expected, gaps, space, vectors, diagnostics, receipts,
              measured, segment_codepoints):
        library = publication["library_ref"]
        members_to_save, object_records = [], defaultdict(list)
        for record in sorted(records, key=lambda row: row["record_version_ref"]):
            pool, text_key = record["pool"], record["text_sha256"]
            cache = vectors.get(pool, {}).get(text_key, {})
            member = dict(record_version_ref=record["record_version_ref"], text_sha=text_key,
                          space_ref=space["space_ref"] if space else None,
                          profile_ref=space["document_profile_refs"][pool] if space else None,
                          vector_ref=cache.get("vector_ref"), body_sha=digest(record), body=record)
            members_to_save.append(member)
            object_records[record["representation"], record["object_ref"]].append(member)
        coverage = {kind: dict(expected=expected[kind], ready=0, missing=expected[kind], expected_segments=0,
                               ready_segments=0, vector_ready=0, gaps=list(gaps[kind])) for kind in RENDER_VERSIONS}
        for (kind, key), group in sorted(object_records.items()):
            item = coverage[kind]
            missing = [member for member in group if not member["vector_ref"]]
            item["ready"] += 1
            item["missing"] -= 1
            item["expected_segments"] += len(group)
            item["ready_segments"] += len(group)
            item["vector_ready"] += int(not missing)
            if missing:
                pool = group[0]["body"]["pool"]
                reasons = {diagnostics.get(pool, {}).get(row["text_sha"]) for row in missing} - {None}
                item["gaps"].append(dict(object_ref=key, code=next(iter(sorted(reasons)), (
                    "INDEX_VECTOR_NOT_PREPARED" if space else "INDEX_VECTOR_NOT_CONFIGURED")),
                    missing_segments=len(missing)))
        components = {"entity_name": "READY"}
        for prefix, kinds in (("source", ["SOURCE"]), ("knowledge", ["FACT", "OPEN"])):
            total = sum(coverage[kind]["expected"] for kind in kinds)
            ready = sum(coverage[kind]["ready"] for kind in kinds)
            embedded = sum(coverage[kind]["vector_ready"] for kind in kinds)
            components[prefix+"_lexical"] = "READY_EMPTY" if not total else "READY" if ready == total else "PARTIAL"
            components[prefix+"_vector"] = ("READY_EMPTY" if not total else "NOT_CONFIGURED" if not space
                                            else "READY" if embedded == total else "PARTIAL")
        pin = digest([_member_identity(row) for row in members_to_save])
        receipt = dict(target_snapshot_digest=target_digest, membership_digest=pin, embedding=receipts, **measured)
        receipt_ref = ref("index_preparation", receipt)
        body = dict(contract=INDEX_CONTRACT, index_revision="", library_ref=library,
                    base_view_revision=publication["base_view_revision"], target_snapshot_digest=target_digest,
                    source_manifest_ref=publication["source_manifest_ref"], target_revisions=publication["target_revisions"],
                    record_schema_version=RECORD_SCHEMA_VERSION, render_versions=RENDER_VERSIONS.copy(),
                    segment_codepoints=segment_codepoints,
                    space_refs={pool: space["space_ref"] for pool in ("SOURCE", "KNOWLEDGE")} if space else {},
                    components=components, coverage=coverage, coverage_digest=digest(coverage), membership_digest=pin,
                    preparation_receipt_ref=receipt_ref)
        key_material = {k: v for k, v in body.items() if k not in ("index_revision", "preparation_receipt_ref")}
        body["index_revision"] = ref("retrieval_index", key_material)
        body["index_descriptor_ref"] = ref("retrieval_descriptor", body)
        key = body["index_revision"]
        with self.store.transaction() as (q, _):
            if space:
                put_space(q, space)
            inserted = q("""INSERT INTO retrieval_v1.indexes
                             (library_ref,index_revision,index_descriptor_ref,source_manifest_ref,body,body_sha,receipt)
                             VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING index_revision""",
                         [library, key, body["index_descriptor_ref"], body["source_manifest_ref"], Jsonb(body),
                          digest(body), Jsonb(receipt)]).fetchone()
            if not inserted:
                previous = q("""SELECT index_descriptor_ref FROM retrieval_v1.indexes
                                WHERE library_ref=%s AND index_revision=%s""", [library, key]).fetchone()
                require(previous, "INDEX_PREPARATION_CONFLICT", 409)
                return _prepared(read_descriptor(q, library, previous["index_descriptor_ref"]))
            for row in members_to_save:
                record = row["body"]
                q("""INSERT INTO retrieval_v1.records VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                     ON CONFLICT DO NOTHING""",
                  [library, row["record_version_ref"], record["pool"], record["representation"], row["text_sha"],
                   record["source_segment_ref"], Jsonb(record), row["body_sha"]])
                q("INSERT INTO retrieval_v1.memberships VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  [library, key, row["record_version_ref"], row["text_sha"], row["space_ref"], row["profile_ref"],
                   row["vector_ref"]])
            members(q, library, body)
        return _prepared(body)

    def load_prepared_index(self, library_ref, prepared):
        with self.store.transaction(readonly=True) as (q, _):
            descriptor = read_descriptor(q, library_ref, prepared["index_descriptor_ref"])
            require(_prepared(descriptor) == prepared, "INDEX_PREPARED_DIGEST_MISMATCH", 503)
            members(q, library_ref, descriptor)
        return descriptor

    def certify_historical(self, library_ref, view_revision, prepared):
        with self.store.transaction() as (q, _):
            adopted = manifest(q, library_ref, view_revision)
            graph = projection(q, library_ref, view_revision, BUSINESS_KINDS)
            descriptor = validate_prepared(q, publication_for_view(adopted), graph, prepared)
            q("""INSERT INTO retrieval_v1.historical_certifications
                 (library_ref,view_revision,index_descriptor_ref,manifest_sha,descriptor_sha)
                 VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
              [library_ref, view_revision, descriptor["index_descriptor_ref"], digest(adopted), digest(descriptor)])
        return descriptor
