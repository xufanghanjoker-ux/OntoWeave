"""Persist product workspace identity in the same PG transaction as its publication head."""
from hashlib import sha256
from unicodedata import category
from uuid import uuid4

from psycopg.types.json import Jsonb

from ontoweave_identity.storage import lock_publication_owner
from ontoweave_publication.store import ROOT, digest, head, require


_FIELDS = "library_ref,title,workspace_state,workspace_revision"


def migrate_registry(store):
    migrations = ((13, "013-product-library-registry-v1.sql", "WORKSPACE_REGISTRY_MIGRATION_CHANGED"),
                  (14, "014-product-workspace-lifecycle-v1.sql", "WORKSPACE_LIFECYCLE_MIGRATION_CHANGED"))
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-publication-schema'))")
        for version, filename, error in migrations:
            sql = (ROOT / "migrations" / filename).read_bytes()
            pin = sha256(sql).hexdigest()
            saved = q("SELECT sha256 FROM publication_schema_migrations WHERE version=%s", [version]).fetchone()
            if saved:
                require(saved["sha256"] == pin, error)
            else:
                q(sql.decode())
                q("INSERT INTO publication_schema_migrations VALUES(%s,%s)", [version, pin])
    return dict(version=version, sha256=pin, reused=bool(saved))


def _title(value):
    value = (value or "").strip()
    require(0 < len(value) <= 80 and all(category(char) not in {"Cc", "Cs"} for char in value),
            "WORKSPACE_TITLE_INVALID", 422)
    return value


def _lock_operation(q, actor, operation):
    require(0 < len(operation) <= 200 and not any(char.isspace() or category(char) in {"Cc", "Cs"}
                    for char in operation), "WORKSPACE_OPERATION_INVALID", 422)
    q("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", [f"workspace-registration:{actor}:{operation}"])


def require_active(q, library):
    row = q("SELECT workspace_state FROM publication_v1.workspace_registry WHERE library_ref=%s", [library]).fetchone()
    require(not row or row["workspace_state"] == "ACTIVE", "WORKSPACE_ARCHIVED", 409)


class WorkspaceRegistry:
    def __init__(self, store):
        self.store = store

    def list(self, state="ACTIVE"):
        with self.store.transaction(readonly=True) as (q, _):
            return q(f"""SELECT {_FIELDS} FROM publication_v1.workspace_registry WHERE workspace_state=%s
                         ORDER BY created_at,library_ref""", [state]).fetchall()

    def get(self, library):
        with self.store.transaction(readonly=True) as (q, _):
            return q(f"SELECT {_FIELDS} FROM publication_v1.workspace_registry WHERE library_ref=%s",
                     [library]).fetchone()

    def create(self, actor, title, operation):
        title = _title(title)
        with self.store.transaction() as (q, _):
            _lock_operation(q, actor, operation)
            old = q(f"""SELECT {_FIELDS},initial_title FROM publication_v1.workspace_registry
                        WHERE actor_ref=%s AND operation_ref=%s""", [actor, operation]).fetchone()
            if old:
                require(old.pop("initial_title") == title, "WORKSPACE_OPERATION_CONFLICT")
                return old, True
            require(not q("SELECT 1 FROM publication_v1.workspace_operations WHERE actor_ref=%s AND operation_ref=%s",
                          [actor, operation]).fetchone(), "WORKSPACE_OPERATION_CONFLICT")
            library = "library_" + uuid4().hex
            lock_publication_owner(q, library)
            q("INSERT INTO publication_v1.libraries(library_ref) VALUES (%s)", [library])
            row = q(f"""INSERT INTO publication_v1.workspace_registry(library_ref,title,initial_title,actor_ref,operation_ref)
                       VALUES (%s,%s,%s,%s,%s) RETURNING {_FIELDS}""", [library, title, title, actor, operation]).fetchone()
            return row, False

    def lifecycle(self, library, actor, action, revision, operation, title):
        require((action == "RENAME") == (title is not None), "WORKSPACE_LIFECYCLE_INPUT_INVALID", 422)
        if action == "RENAME":
            title = _title(title)
        fingerprint = digest([library, action, revision, title])
        with self.store.transaction() as (q, _):
            _lock_operation(q, actor, operation)
            replay = q("""SELECT request_sha,response FROM publication_v1.workspace_operations
                          WHERE actor_ref=%s AND operation_ref=%s""", [actor, operation]).fetchone()
            if replay:
                require(replay["request_sha"] == fingerprint, "WORKSPACE_OPERATION_CONFLICT")
                return replay["response"]
            require(not q("SELECT 1 FROM publication_v1.workspace_registry WHERE actor_ref=%s AND operation_ref=%s",
                          [actor, operation]).fetchone(), "WORKSPACE_OPERATION_CONFLICT")
            state = head(q, library, lock=True)
            row = q(f"SELECT {_FIELDS} FROM publication_v1.workspace_registry WHERE library_ref=%s",
                    [library]).fetchone()
            require(row, "WORKSPACE_LIFECYCLE_UNSUPPORTED", 404)
            require(row["workspace_revision"] == revision, "WORKSPACE_REVISION_STALE",
                    workspace_revision=row["workspace_revision"])
            expected = "ARCHIVED" if action == "RESTORE" else "ACTIVE"
            require(row["workspace_state"] == expected, "WORKSPACE_LIFECYCLE_STATE_CONFLICT")
            if action == "ARCHIVE":
                busy = q("""SELECT EXISTS (
                    SELECT 1 FROM publication_v1.builds WHERE library_ref=%s
                    AND body->>'execution_status' IN ('QUEUED','RUNNING','UNKNOWN_HOLD')
                    UNION ALL
                    SELECT 1 FROM publication_v1.jobs WHERE library_ref=%s
                    AND status IN ('QUEUED','RUNNING','UNKNOWN_HOLD')
                    ) AS busy""", [library, library]).fetchone()["busy"]
                require(not busy and not state["pending_view_revision"], "WORKSPACE_HAS_UNSETTLED_WORK")
            target = "ARCHIVED" if action == "ARCHIVE" else "ACTIVE"
            saved = q(f"""UPDATE publication_v1.workspace_registry SET title=COALESCE(%s,title),
                        workspace_state=%s,workspace_revision=workspace_revision+1 WHERE library_ref=%s
                        RETURNING {_FIELDS}""", [title, target, library]).fetchone()
            q("INSERT INTO publication_v1.workspace_operations VALUES(%s,%s,%s,%s,%s)",
              [actor, operation, library, fingerprint, Jsonb(saved)])
            return saved
