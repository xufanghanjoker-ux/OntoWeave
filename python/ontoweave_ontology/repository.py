"""Immutable revision staging and hash-checked PostgreSQL readback."""

from pathlib import Path

from psycopg.types.json import Jsonb
from ontoweave_cq.store import require, sha
from ontoweave_cq_similarity.core import digest
from ontoweave_identity.input import ref

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations/008-ontology-alignment-v1.sql"
OBSERVATIONS = {"supports", "observed_domains", "observed_ranges", "observed_datatypes", "source_statement_refs"}


def component_key(assignment):
    return digest({k: v for k, v in assignment.items() if k not in ("statement_ref", "binding_ref")})


def combine_definition(previous, current):
    if not previous:
        return current
    for field in OBSERVATIONS:
        if field == "supports":
            supports = {digest(s): s for s in [*previous.get(field, []), *current.get(field, [])]}
            current = {**current, field: [supports[k] for k in sorted(supports)]}
        else:
            current = {**current, field: sorted(set(previous.get(field, [])).union(current.get(field, [])))}
    return current


class OntologyRepository:
    def __init__(self, store):
        self.store = store

    def migrate(self):
        content = MIGRATION.read_bytes()
        pin = sha(content)
        with self.store.transaction() as (q, _):
            q("SELECT pg_advisory_xact_lock(hashtextextended('ontology-v1-migration',0))")
            exists = q("SELECT to_regclass('ontology_v1.schema_version') AS present").fetchone()["present"]
            if exists:
                row = q("SELECT sha256 FROM ontology_v1.schema_version WHERE version=8").fetchone()
                require(row and row["sha256"] == pin, "ONTOLOGY_MIGRATION_CHANGED")
            else:
                q(content.decode("utf-8"))
                q("INSERT INTO ontology_v1.schema_version VALUES (8,%s)", [pin])
        return dict(version=8, sha256=pin, reused=bool(exists))

    @staticmethod
    def _save_receipt(q, library, run, key, receipt):
        pin = digest(receipt)
        q("""INSERT INTO ontology_v1.run_receipts VALUES (%s,%s,%s,%s,%s)
             ON CONFLICT DO NOTHING""", [library, run, key, pin, Jsonb(receipt)])
        row = q("""SELECT sha256 FROM ontology_v1.run_receipts
                   WHERE library_ref=%s AND run_ref=%s AND receipt_key=%s""", [library, run, key]).fetchone()
        require(row["sha256"] == pin, "ONTOLOGY_RECEIPT_IMMUTABLE")

    def receipt(self, library, run, key):
        with self.store.transaction(readonly=True) as (q, _):
            row = q("""SELECT sha256,payload FROM ontology_v1.run_receipts
                       WHERE (library_ref,run_ref,receipt_key)=(%s,%s,%s)""", [library, run, key]).fetchone()
        if row:
            require(digest(row["payload"]) == row["sha256"], "ONTOLOGY_RECEIPT_INTEGRITY")
            return row["payload"]

    def save_receipt(self, library, run, key, receipt):
        with self.store.transaction() as (q, _):
            self._save_receipt(q, library, run, key, receipt)

    def claim_batch(self, library, run, batch):
        # Commit the dispatch fence separately so a worker crash is held for reconciliation.
        receipt = dict(status="DISPATCHED", batch_ref=batch)
        with self.store.transaction() as (q, _):
            return bool(q("""INSERT INTO ontology_v1.run_receipts VALUES (%s,%s,%s,%s,%s)
                          ON CONFLICT DO NOTHING RETURNING receipt_key""",
                          [library, run, "dispatch:" + batch, digest(receipt), Jsonb(receipt)]).fetchone())

    @staticmethod
    def _revision(q, library, revision):
        row = q("""SELECT * FROM ontology_v1.revisions
                   WHERE library_ref=%s AND ontology_revision=%s""", [library, revision]).fetchone()
        require(row and digest(row["result"]) == row["result_sha256"], "ONTOLOGY_REVISION_UNKNOWN_OR_CHANGED")
        return row

    def by_run(self, library, run, input_sha256):
        with self.store.transaction(readonly=True) as (q, _):
            row = q("""SELECT ontology_revision,input_sha256 FROM ontology_v1.revisions
                       WHERE library_ref=%s AND run_ref=%s""", [library, run]).fetchone()
            if row:
                require(row["input_sha256"] == input_sha256, "ONTOLOGY_RUN_INPUT_CHANGED")
                return self._revision(q, library, row["ontology_revision"])["result"]

    def read(self, library_ref, ontology_revision):
        with self.store.transaction(readonly=True) as (q, _):
            return self._revision(q, library_ref, ontology_revision)["result"]

    def snapshot(self, library, revision):
        definitions, assignments, bindings = {}, {}, {}
        constraints, aliases, resolutions = {}, {}, {}
        if revision is None:
            return dict(definitions=[], assignments=[], bindings=[], adopted_constraints=[],
                        definition_aliases={}, review_resolutions=[])
        with self.store.transaction(readonly=True) as (q, _):
            ancestry = []
            while revision is not None:
                row = self._revision(q, library, revision)
                ancestry.append(row["result"])
                revision = row["parent_revision"]
            withdrawn = set()
            for result in reversed(ancestry):
                withdrawn.update(result.get("withdrawn_statement_refs", []))
                constraints.update((item["constraint_ref"], item) for item in result.get("adopted_constraints", []))
                aliases.update(result.get("definition_aliases", {}))
                resolutions.update((item["review_ref"], item) for item in result.get("review_resolutions", []))
                for definition in result["definition_changes"]:
                    key = definition["definition_key"]
                    previous = definitions.get(key)
                    definitions[key] = combine_definition(previous if previous and
                        previous["definition_ref"] == definition["definition_ref"] else None, definition)
                for statement in result.get("processed_statement_refs", result["affected_statement_refs"]):
                    assignments.pop(statement, None)
                for assignment in result["statement_assignments"]:
                    withdrawn.discard(assignment["statement_ref"])
                    assignments.setdefault(assignment["statement_ref"], []).append(assignment)
                bindings.update((b["binding_ref"], b) for b in result["bindings"])
        for key, definition in definitions.items():
            if withdrawn.intersection(definition.get("source_statement_refs", [])):
                definitions[key] = {**definition,
                    "source_statement_refs": sorted(set(definition["source_statement_refs"]) - withdrawn),
                    "supports": [s for s in definition.get("supports", []) if s["statement_ref"] not in withdrawn],
                }
        rows = [a for items in assignments.values() for a in items]
        constraints = {key: item for key, item in constraints.items()
                       if not withdrawn.intersection(item["source_statement_refs"])}
        return dict(definitions=list(definitions.values()), assignments=rows,
                    bindings=[bindings[k] for k in sorted({a["binding_ref"] for a in rows})],
                    adopted_constraints=list(constraints.values()), definition_aliases=aliases,
                    review_resolutions=list(resolutions.values()))

    def save(self, result, parent, input_sha256, signatures, *, check_basis=None):
        with self.store.transaction() as (q, _):
            if check_basis and not check_basis(q):
                self._save_receipt(q, result["library_ref"], result["run_ref"], "stale",
                                   dict(status="LATE_ARCHIVED", result=result))
                return None
            return self.save_in_transaction(q, result, parent, input_sha256, signatures)

    @classmethod
    def save_in_transaction(cls, q, result, parent, input_sha256, signatures):
        """Stage using an open caller transaction; the caller owns commit and activation."""
        library, run = result["library_ref"], result["run_ref"]
        revision = result["target_ontology_revision"]
        q("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ["ontology:" + library])
        prior = q("""SELECT ontology_revision,input_sha256 FROM ontology_v1.revisions
                     WHERE library_ref=%s AND run_ref=%s""", [library, run]).fetchone()
        if prior:
            require(prior["input_sha256"] == input_sha256, "ONTOLOGY_RUN_INPUT_CHANGED")
            return cls._revision(q, library, prior["ontology_revision"])["result"]
        q("""INSERT INTO ontology_v1.revisions VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
          [library, revision, parent, result["identity_revision"], run, result["base_view_revision"],
           input_sha256, digest(result), Jsonb(result)])
        for definition in result["definition_changes"]:
            key = definition["definition_ref"]
            payload = {k: v for k, v in definition.items() if k not in OBSERVATIONS}
            pin = digest(payload)
            q("""INSERT INTO ontology_v1.definitions VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                 ON CONFLICT DO NOTHING""",
              [library, key, definition["definition_key"], definition["kind"], definition["label"],
               definition["definition_status"], pin, Jsonb(payload)])
            existing = q("""SELECT content_sha256 FROM ontology_v1.definitions
                            WHERE (library_ref,definition_ref)=(%s,%s)""", [library, key]).fetchone()
            require(existing["content_sha256"] == pin, "ONTOLOGY_DEFINITION_IMMUTABLE")
            for support in definition.get("supports", []):
                q("INSERT INTO ontology_v1.definition_supports VALUES (%s,%s,%s,%s,%s,%s,%s)",
                  [library, revision, key, support["statement_ref"], support["source_ref"],
                   digest(support), Jsonb(support)])
        for group in signatures:
            q("""INSERT INTO ontology_v1.alignment_signatures VALUES (%s,%s,%s,%s,%s)
                 ON CONFLICT DO NOTHING""", [library, group["alignment_signature_ref"], group["basis_sha256"],
                                           group["shape_key"], Jsonb(group)])
        for binding in result["bindings"]:
            q("""INSERT INTO ontology_v1.bindings VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                 ON CONFLICT DO NOTHING""",
              [library, binding["binding_ref"], binding["alignment_signature_ref"], binding["basis_sha256"],
               binding["definition_ref"], binding["binding_state"], binding["direction"], Jsonb(binding)])
        for assignment in result["statement_assignments"]:
            q("INSERT INTO ontology_v1.statement_assignments VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
              [library, revision, assignment["statement_ref"], assignment["component_role"],
               component_key(assignment), assignment.get("target_occurrence_ref"),
               assignment.get("qualifier_position"), assignment["binding_ref"], Jsonb(assignment)])
        for proposal in result["constraint_proposals"]:
            q("INSERT INTO ontology_v1.constraint_proposals VALUES (%s,%s,%s,%s,%s)",
              [library, revision, proposal["proposal_ref"], proposal["definition_ref"], Jsonb(proposal)])
        cls._save_receipt(q, library, run, "final", dict(
            status=result["execution_status"], ontology_revision=revision, result_sha256=digest(result)))
        return result

    def read_constraint_proposal(self, library, revision, proposal_ref):
        """Read a proposal only from the explicit revision's ancestry."""
        with self.store.transaction(readonly=True) as (q, _):
            while revision is not None:
                row = self._revision(q, library, revision)
                for proposal in row["result"]["constraint_proposals"]:
                    if proposal["proposal_ref"] == proposal_ref:
                        return proposal
                revision = row["parent_revision"]

    def certificate(self, library, revision):
        with self.store.transaction(readonly=True) as (q, _):
            row = self._revision(q, library, revision)
            result = row["result"]
            keys = [b["binding_ref"] for b in result["bindings"]]
            assignments = q("""SELECT payload FROM ontology_v1.statement_assignments
                               WHERE library_ref=%s AND ontology_revision=%s""", [library, revision]).fetchall()
            bindings = q("""SELECT payload FROM ontology_v1.bindings
                            WHERE library_ref=%s AND binding_ref=ANY(%s)""", [library, keys]).fetchall()
            definitions = q("""SELECT payload,content_sha256 FROM ontology_v1.definitions
                               WHERE library_ref=%s AND definition_ref=ANY(%s)""",
                            [library, [d["definition_ref"] for d in result["definition_changes"]]]).fetchall()
            supports = q("""SELECT payload FROM ontology_v1.definition_supports
                            WHERE library_ref=%s AND ontology_revision=%s""", [library, revision]).fetchall()
            expected = dict(assignments=result["statement_assignments"], bindings=result["bindings"],
                            definitions=[{k: v for k, v in d.items() if k not in OBSERVATIONS}
                                         for d in result["definition_changes"]],
                            supports=[s for d in result["definition_changes"] for s in d.get("supports", [])])
            actual = dict(assignments=assignments, bindings=bindings, definitions=definitions, supports=supports)
            for key in expected:
                require(sorted(map(digest, expected[key])) == sorted(digest(r["payload"]) for r in actual[key]),
                        "ONTOLOGY_READBACK_" + key.upper() + "_DIFF")
            require(all(digest(d["payload"]) == d["content_sha256"] for d in definitions),
                    "ONTOLOGY_DEFINITION_HASH_CHANGED")
        return dict(revision=revision, parent_revision=row["parent_revision"], result_sha256=row["result_sha256"],
                    **{key: len(rows) for key, rows in actual.items()})

    def routing_bundle(self, library, revision):
        result = self.read(library, revision)
        snapshot = self.snapshot(library, revision)
        certificate = self.certificate(library, revision)
        return routing_projection(result, snapshot, certificate)


def routing_projection(result, snapshot, certificate=None):
    """Project an immutable result into facts input, including explicitly adopted policy."""
    policies = snapshot.get("adopted_constraints", [])
    by_definition = {}
    for policy in policies:
        by_definition.setdefault(policy["definition_ref"], set()).add(policy["constraint_ref"])
    definitions = []
    for definition in snapshot["definitions"]:
        extra = by_definition.get(definition["definition_ref"])
        definitions.append(dict(definition, constraint_refs=sorted(set(definition.get("constraint_refs", [])) | extra))
                           if extra else definition)
    item = dict(bundle_ref=result["target_ontology_revision"], result=result, definitions=definitions,
                adopted_constraints=policies)
    return dict(item, certificate=certificate) if certificate is not None else item
