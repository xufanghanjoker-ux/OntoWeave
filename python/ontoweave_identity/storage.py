"""Identity-owned persistence atop the shared Psycopg pool."""

from pathlib import Path

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import canonical, digest, vector

from .input import ref
from .matching import Groups

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations/006-identity-v1.sql"
CONTINUATION_MIGRATION = ROOT / "migrations/007-identity-continuations.sql"


def migrate(store):
    raw = MIGRATION.read_bytes()
    pin = sha(raw)
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtextextended('ontoweave-identity-v1-migration', 0))")
        exists = q("SELECT to_regclass('identity_v1.schema_version') AS present").fetchone()["present"]
        if exists:
            row = q("SELECT sha256 FROM identity_v1.schema_version WHERE version=6").fetchone()
            require(row and row["sha256"] == pin, "IDENTITY_MIGRATION_CHANGED")
        else:
            q(raw.decode("utf-8"))
            q("INSERT INTO identity_v1.schema_version VALUES (6,%s)", [pin])
        successor = CONTINUATION_MIGRATION.read_bytes()
        successor_pin = sha(successor)
        row = q("SELECT sha256 FROM identity_v1.schema_version WHERE version=7").fetchone()
        if row:
            require(row["sha256"] == successor_pin, "IDENTITY_CONTINUATION_MIGRATION_CHANGED")
        else:
            q(successor.decode("utf-8"))
            q("INSERT INTO identity_v1.schema_version VALUES (7,%s)", [successor_pin])
    return dict(version=7, sha256=successor_pin, predecessor_sha256=pin, reused=bool(row))


def lock_publication_owner(q, library):
    q("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ["publication-owner:" + library])


def is_publication_managed(q, library):
    exists = q("SELECT to_regclass('publication_v1.libraries') AS present").fetchone()["present"]
    return bool(exists and q("SELECT 1 FROM publication_v1.libraries WHERE library_ref=%s", [library]).fetchone())


def library_lock(q, library, *, publisher=False):
    lock_publication_owner(q, library)
    require(publisher == is_publication_managed(q, library), "IDENTITY_PUBLICATION_OWNER_MISMATCH")
    q("INSERT INTO identity_v1.libraries(library_ref) VALUES(%s) ON CONFLICT DO NOTHING", [library])
    return q("SELECT * FROM identity_v1.libraries WHERE library_ref=%s FOR UPDATE", [library]).fetchone()


def revision_at(q, library, revision):
    if revision is None:
        return None
    row = q("SELECT * FROM identity_v1.revisions WHERE library_ref=%s AND revision=%s",
            [library, revision]).fetchone()
    require(row, "IDENTITY_REVISION_UNKNOWN")
    return row


def check_base(q, head, request):
    revision = revision_at(q, head["library_ref"], head["active_revision"])
    values = [(revision or {}).get(key) for key in ("identity_revision", "view_revision")]
    require(values == [request.get("base_identity_revision"), request.get("base_view_revision")],
            "IDENTITY_BASE_STALE")
    return revision


def create_revision(q, head, seed):
    require(head["pending_revision"] is None, "IDENTITY_APPLICATION_PENDING")
    library = head["library_ref"]
    parent = head["active_revision"]
    revision = (parent or 0) + 1
    identity = ref("identity_rev", [library, revision, seed])
    view = ref("identity_view", [library, identity])
    row = q("""INSERT INTO identity_v1.revisions
               (library_ref,revision,parent_revision,identity_revision,view_revision)
               VALUES(%s,%s,%s,%s,%s) RETURNING *""",
            [library, revision, parent, identity, view]).fetchone()
    q("UPDATE identity_v1.libraries SET pending_revision=%s WHERE library_ref=%s", [revision, library])
    return row


def product_scope(q, library, revision):
    exists = q("SELECT to_regclass('identity_v1.product_source_scopes') AS present").fetchone()["present"]
    if exists:
        return q("""SELECT occurrence_refs,statement_refs FROM identity_v1.product_source_scopes
                    WHERE library_ref=%s AND revision<=%s ORDER BY revision DESC LIMIT 1""",
                 [library, revision or 0]).fetchone()
    return None


def source_state(q, library, revision):
    version = revision or 0
    scope = product_scope(q, library, revision)
    occurrences = q("""SELECT o.* FROM identity_v1.occurrences o
                       JOIN identity_v1.entities e ON (e.library_ref,e.entity_ref)=(o.library_ref,o.home_entity_ref)
                       LEFT JOIN identity_v1.statements s
                         ON (s.library_ref,s.statement_ref)=(o.library_ref,o.statement_ref)
                       WHERE o.library_ref=%s AND e.first_revision<=%s
                         AND (s.first_revision IS NULL OR s.first_revision<=%s)
                         AND (%s OR o.occurrence_ref=ANY(%s))
                       ORDER BY occurrence_ref""",
                    [library, version, version, scope is None, (scope or {}).get("occurrence_refs", [])]).fetchall()
    statements = q("""SELECT statement_ref,payload FROM identity_v1.statements
                      WHERE library_ref=%s AND first_revision<=%s
                        AND (%s OR statement_ref=ANY(%s)) ORDER BY statement_ref""",
                   [library, version, scope is None, (scope or {}).get("statement_refs", [])]).fetchall()
    return ({row["occurrence_ref"]: row["home_entity_ref"] for row in occurrences},
            {row["occurrence_ref"]: row["payload"] for row in occurrences},
            {row["statement_ref"]: row["payload"] for row in statements})


def decisions_at(q, library, revision):
    rows = q("""SELECT payload,revision,created_at FROM identity_v1.decisions WHERE library_ref=%s AND revision<=%s
                ORDER BY revision,ordinal""", [library, revision or 0]).fetchall()
    return [{**row["payload"], "stored_revision": row["revision"],
             "recorded_at": row["created_at"].isoformat()} for row in rows]


def reviews_at(q, library, revision):
    rows = q("""SELECT payload,first_revision FROM identity_v1.reviews WHERE library_ref=%s AND first_revision<=%s
                ORDER BY first_revision,review_ref""", [library, revision or 0]).fetchall()
    overrides = q("""SELECT payload->'review_overrides' AS overrides FROM identity_v1.publication_jobs
                     WHERE library_ref=%s AND revision<=%s AND payload ? 'review_overrides'
                     ORDER BY revision""", [library, revision or 0]).fetchall()
    patches = {key: patch for row in overrides for key, patch in row["overrides"].items()}
    return [{**row["payload"], "stored_revision": row["first_revision"],
             **patches.get(row["payload"]["review_ref"], {})} for row in rows]


def bindings_at(q, library, revision):
    scope = product_scope(q, library, revision)
    rows = q("""SELECT DISTINCT ON (occurrence_ref) occurrence_ref,entity_ref,decision_ref
                FROM identity_v1.bindings WHERE library_ref=%s AND revision<=%s
                  AND (%s OR occurrence_ref=ANY(%s))
                ORDER BY occurrence_ref,revision DESC""",
             [library, revision or 0, scope is None, (scope or {}).get("occurrence_refs", [])]).fetchall()
    return {row["occurrence_ref"]: row for row in rows}


def insert_decision(q, library, revision, decision, ordinal):
    q("""INSERT INTO identity_v1.decisions
         (library_ref,decision_ref,revision,ordinal,request_ref,payload)
         VALUES(%s,%s,%s,%s,%s,%s)""",
      [library, decision["decision_ref"], revision, ordinal, decision["request_ref"], Jsonb(decision)])


def update_bindings(q, library, revision, homes, groups, previous):
    updates = {}
    for occurrence, home in homes.items():
        entity = groups.representative[home]
        old = previous.get(occurrence)
        decision = groups.provenance.get(home)
        if old and old["entity_ref"] == entity and old["decision_ref"] == decision:
            continue
        q("""INSERT INTO identity_v1.bindings
             (library_ref,occurrence_ref,revision,entity_ref,decision_ref) VALUES(%s,%s,%s,%s,%s)""",
          [library, occurrence, revision, entity, decision])
        updates[occurrence] = dict(occurrence_ref=occurrence, entity_ref=entity, decision_ref=decision)
    return updates


def cache_name_vectors(store, library, space, values, receipt):
    """Import a scoped name-only embedding batch. The caller owns the provider ledger."""
    require(space.get("purpose") == "ENTITY_NAME" and isinstance(space.get("dimensions"), int)
            and space["dimensions"] > 0 and space.get("model"), "IDENTITY_NAME_SPACE_INVALID")
    space_ref = ref("entity_name_space", space)
    with store.transaction() as (q, _):
        library_lock(q, library)
        for text, embedding in values.items():
            embedding = vector(embedding, space["dimensions"])
            key = [library, "ENTITY_NAME", space_ref, sha(text)]
            payload = dict(space=space, vector_sha256=digest(embedding), receipt=receipt)
            q("""INSERT INTO identity_v1.name_vectors
                 VALUES(%s,%s,%s,%s,%s,%s::vector,%s) ON CONFLICT DO NOTHING""",
              [*key, text, canonical(embedding), Jsonb(payload)])
            old = q("""SELECT input_text,payload FROM identity_v1.name_vectors
                       WHERE (library_ref,purpose,space_ref,input_sha256)=(%s,%s,%s,%s)""", key).fetchone()
            require(old["input_text"] == text and old["payload"]["vector_sha256"] == payload["vector_sha256"],
                    "IDENTITY_NAME_VECTOR_CONFLICT")
    return space_ref


def vector_neighbors(q, library, config, profiles, new_refs):
    if config is None:
        return {}, dict(status="NOT_CONFIGURED", truncation=0)
    space_ref, floor = config["space_ref"], config["cosine_floor"]
    require(space_ref.startswith("entity_name_space_") and 0 < floor <= 1 and config.get("calibration_ref"),
            "IDENTITY_VECTOR_STRATEGY_INVALID")
    texts = {entity: sorted(set(p["names"] + p["aliases"])) for entity, p in profiles.items() if not p["local_only"]}
    rows = q("""WITH targets AS (
                  SELECT x.entity_ref,v.embedding
                  FROM jsonb_to_recordset(%s::jsonb) x(entity_ref text,input_text text)
                  JOIN identity_v1.name_vectors v ON v.input_text=x.input_text
                  WHERE v.library_ref=%s AND v.purpose='ENTITY_NAME' AND v.space_ref=%s
                ), scores AS (
                  SELECT src.entity_ref AS origin,dst.entity_ref AS target,
                         max(1-(src.embedding <=> dst.embedding)) AS score
                  FROM targets src JOIN targets dst ON src.entity_ref<>dst.entity_ref
                  WHERE src.entity_ref=ANY(%s)
                  GROUP BY src.entity_ref,dst.entity_ref
                )
                SELECT origin,target,score FROM scores WHERE score>=%s ORDER BY origin,score DESC,target""",
             [Jsonb([dict(entity_ref=e, input_text=t) for e, names in texts.items() for t in names]),
              library, space_ref, sorted(new_refs), floor]).fetchall()
    kept, truncation = {}, 0
    for row in rows:
        neighbors = kept.setdefault(row["origin"], [])
        if len(neighbors) < 5:
            neighbors.append(row["target"])
        else:
            truncation += 1
    coverage = q("""SELECT input_text FROM identity_v1.name_vectors
                    WHERE library_ref=%s AND purpose='ENTITY_NAME' AND space_ref=%s""",
                 [library, space_ref]).fetchall()
    text_set = {t for names in texts.values() for t in names}
    hits = {row["input_text"] for row in coverage} & text_set
    return kept, dict(status="CACHED" if hits == text_set else "PARTIAL_CACHE",
                      space_ref=space_ref, cosine_floor=floor, calibration_ref=config["calibration_ref"],
                      cached_names=len(hits), missing_names=sorted(text_set - hits), truncation=truncation)
