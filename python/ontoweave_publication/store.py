import hashlib
import json
from pathlib import Path

from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]


class PublicationError(Exception):
    def __init__(self, code, status=409, details=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.details = details or {}


def require(condition, code, status=409, **details):
    if not condition:
        raise PublicationError(code, status, details)


def digest(body):
    content = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(content.encode()).hexdigest()


def ref(kind, *parts):
    return f"{kind}_{digest(parts)}"


def migrate(store):
    data = (ROOT / "migrations/010-publication-local-update-v1.sql").read_bytes()
    checksum = hashlib.sha256(data).hexdigest()
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-publication-schema'))")
        q("""CREATE TABLE IF NOT EXISTS publication_schema_migrations(
              version integer PRIMARY KEY, sha256 text NOT NULL)""")
        existing = q("SELECT sha256 FROM publication_schema_migrations WHERE version=10").fetchone()
        if existing:
            require(existing["sha256"] == checksum, "PUBLICATION_MIGRATION_CHANGED")
        else:
            q(data.decode())
            q("INSERT INTO publication_schema_migrations VALUES(10,%s)", [checksum])
    return {"version": 10, "sha256": checksum, "reused": bool(existing)}


def head(q, library, *, lock=False):
    row = q("SELECT * FROM publication_v1.libraries WHERE library_ref=%s" +
            (" FOR UPDATE" if lock else ""), [library]).fetchone()
    require(row, "LIBRARY_NOT_FOUND", 404)
    return row


def assert_workspace_writable(store, q, library):
    guard = getattr(store, "workspace_write_guard", None)
    if guard:
        guard(q, library)


def assert_base(state, base):
    current = state["active_view_revision"]
    require(current == base, "VIEW_BASE_STALE", current_view_revision=current)
    require(not state["pending_view_revision"], "PUBLICATION_CONFIRMATION_PENDING",
            target_view_revision=state["pending_view_revision"])


def manifest(q, library, view):
    row = q("""SELECT m.body,m.body_sha,c.activated_at FROM publication_v1.manifests m
               JOIN publication_v1.confirmations c USING(library_ref,view_revision)
               WHERE m.library_ref=%s AND m.view_revision=%s""", [library, view]).fetchone()
    require(row, "VIEW_NOT_PUBLISHED", 404)
    require(digest(row["body"]) == row["body_sha"], "MANIFEST_DIGEST_MISMATCH", 503)
    return dict(row["body"], library_ref=library, activated_at=row["activated_at"].isoformat())


def projection(q, library, view, kinds):
    if view is None:
        return {}
    rows = q("""WITH RECURSIVE lineage AS (
                   SELECT view_revision,parent_view_revision,job_ref,activation_seq
                   FROM publication_v1.manifests WHERE library_ref=%s AND view_revision=%s
                   UNION ALL
                   SELECT m.view_revision,m.parent_view_revision,m.job_ref,m.activation_seq
                   FROM publication_v1.manifests m JOIN lineage l ON m.view_revision=l.parent_view_revision
                   WHERE m.library_ref=%s
               ), latest AS (
                   SELECT DISTINCT ON (p.kind,p.object_ref) p.kind,p.object_ref,p.body
                   FROM lineage l JOIN publication_v1.projection_delta p ON p.job_ref=l.job_ref
                   WHERE p.library_ref=%s AND p.kind=ANY(%s)
                   ORDER BY p.kind,p.object_ref,l.activation_seq DESC
               ) SELECT * FROM latest WHERE body IS NOT NULL""",
             [library, view, library, library, list(kinds)]).fetchall()
    return {(r["kind"], r["object_ref"]): r["body"] for r in rows}


def review_context_views(q, library, view):
    """Index-only publications keep the current business review context."""
    return [row["view_revision"] for row in q("""
        WITH RECURSIVE context AS (
          SELECT view_revision,parent_view_revision,body FROM publication_v1.manifests
          WHERE library_ref=%s AND view_revision=%s
          UNION ALL
          SELECT parent.view_revision,parent.parent_view_revision,parent.body
          FROM publication_v1.manifests parent JOIN context current ON parent.view_revision=current.parent_view_revision
          WHERE parent.library_ref=%s AND current.body->>'index_refresh'='true'
        ) SELECT view_revision FROM context
        """, [library, view, library]).fetchall()]


def review_rows(q, library, view):
    adopted = projection(q, library, view, ("REVIEW",))
    if view is not None:
        feedback = q("""SELECT body->'review' AS review FROM publication_v1.feedback
                        WHERE library_ref=%s AND view_revision=ANY(%s) AND body ? 'review'
                        ORDER BY operation_ref""", [library, review_context_views(q, library, view)]).fetchall()
        for row in feedback:
            review = row["review"]
            if review:
                adopted.setdefault(("REVIEW", review["review_ref"]), review)
    return adopted


def event(q, library, kind, payload, *, run=None, job=None, view=None, change=None):
    q("""INSERT INTO publication_v1.outbox(library_ref,event_type,run_ref,job_ref,view_revision,change_ref,payload)
         VALUES(%s,%s,%s,%s,%s,%s,%s)""", [library, kind, run, job, view, change, Jsonb(payload)])


def get_job(q, library, job):
    row = q("SELECT * FROM publication_v1.jobs WHERE library_ref=%s AND job_ref=%s", [library, job]).fetchone()
    require(row, "JOB_NOT_FOUND", 404)
    return row


def steps(q, library, job):
    rows = q("""SELECT step,input_sha,output_sha,receipt FROM publication_v1.job_steps
                WHERE library_ref=%s AND job_ref=%s""", [library, job]).fetchall()
    for row in rows:
        require(digest(row["receipt"]) == row["output_sha"], "STEP_DIGEST_MISMATCH", 503, step=row["step"])
    return {row["step"]: row for row in rows}
