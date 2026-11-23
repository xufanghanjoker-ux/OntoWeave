"""PostgreSQL durability for the native query gateway."""

from hashlib import sha256
from pathlib import Path
from uuid import UUID

from psycopg.types.json import Jsonb

from ontoweave_publication.store import require

ROOT = Path(__file__).resolve().parents[2]
KINDS = frozenset({
    "native_query_product_v1", "native_query_request_v1", "native_query_conversation_v1",
    "native_query_chat_turn_v1", "native_query_chat_event_v1", "native_query_operation_v1",
    "native_query_invocation_v1", "native_query_wire_v1", "native_query_response_v1",
    "native_query_response_derivation_v1", "native_query_tool_readiness_v1",
    "native_query_product_references_v1", "native_agent_references_v1",
    "native_agent_argument_normalization_v1", "source_model_config_revision",
})
EVENT = "native_query_chat_event_v1"
LEASE_SECONDS = 60


def migrate(store):
    source = (ROOT / "migrations/017-query-sessions-v1.sql").read_bytes()
    digest = sha256(source).hexdigest()
    with store.transaction() as (q, _):
        q("SELECT pg_advisory_xact_lock(hashtext('ontoweave-query-sessions-v1-schema'))")
        exists = q("SELECT to_regclass('query_sessions_v1.schema_version') AS present").fetchone()["present"]
        if not exists:
            q(source.decode())
            q("INSERT INTO query_sessions_v1.schema_version VALUES (17,%s)", [digest])
        else:
            row = q("SELECT sha256 FROM query_sessions_v1.schema_version WHERE version=17").fetchone()
            require(row and row["sha256"] == digest, "QUERY_SESSION_SCHEMA_CHANGED", 503)


def valid_id(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and "\x00" not in value


def gateway(q):
    return q("""SELECT *, COALESCE(lease_until > clock_timestamp(),false) AS live
                FROM query_sessions_v1.gateway WHERE singleton FOR UPDATE""").fetchone()


def _valid_row(row):
    require(isinstance(row, dict) and set(row) == {"kind", "id", "payload", "updated_at"}
            and isinstance(row["kind"], str) and row["kind"] in KINDS and valid_id(row["id"]) and isinstance(row["payload"], dict)
            and valid_id(row["updated_at"]), "QUERY_SESSION_RECORD_INVALID", 422)


def put(q, row):
    _valid_row(row)
    q("""INSERT INTO query_sessions_v1.records(kind,id,payload,updated_at) VALUES(%s,%s,%s,%s)
         ON CONFLICT(kind,id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at""",
      [row["kind"], row["id"], Jsonb(row["payload"]), row["updated_at"]])


class QuerySessionStore:
    def __init__(self, store):
        self.store = store

    def dispatch(self, body):
        require(isinstance(body, dict), "QUERY_SESSION_REQUEST_INVALID", 422)
        action = body.get("action")
        fields = {
            "claim": set(), "heartbeat": set(), "release": set(), "revision": set(),
            "get": {"kind","id"}, "list": {"kind","library"},
            "events": {"query","after","limit"}, "commit": {"revision","rows"},
        }
        require(isinstance(action,str) and action in fields and set(body) == {"action","owner"} | fields[action],
                "QUERY_SESSION_REQUEST_INVALID", 422)
        raw_owner = body["owner"]
        try:
            owner = UUID(raw_owner) if isinstance(raw_owner,str) else None
        except ValueError:
            owner = None
        require(owner is not None, "QUERY_SESSION_OWNER_INVALID", 422)
        with self.store.transaction() as (q, _):
            row = gateway(q)
            if action == "claim":
                require(not row["live"] or row["owner"] == owner, "QUERY_SESSION_GATEWAY_ACTIVE", 409)
                self._extend(q, owner)
                return {"revision":str(row["revision"])}
            require(row["live"] and row["owner"] == owner, "QUERY_SESSION_GATEWAY_FENCED", 409)
            if action == "release":
                q("UPDATE query_sessions_v1.gateway SET owner=NULL,lease_until=NULL WHERE singleton")
                return {"released":True}
            if action == "heartbeat":
                self._extend(q, owner)
                return {"revision":str(row["revision"])}
            if action == "revision":
                return {"revision":str(row["revision"])}
            if action == "commit":
                require(body["revision"] == str(row["revision"]), "QUERY_SESSION_WRITE_CONFLICT", 409)
                batch = body["rows"]
                require(isinstance(batch,list) and batch, "QUERY_SESSION_BATCH_INVALID", 422)
                for record in batch:
                    put(q, record)
                revision = q("""UPDATE query_sessions_v1.gateway SET revision=revision+1
                                WHERE singleton RETURNING revision""").fetchone()["revision"]
                return {"revision":str(revision)}
            if action == "events":
                return {"rows":self._events(q, body)}
            kind = body["kind"]
            require(isinstance(kind,str) and kind in KINDS, "QUERY_SESSION_KIND_INVALID", 422)
            if action == "get":
                require(valid_id(body["id"]), "QUERY_SESSION_RECORD_INVALID", 422)
                record = q("""SELECT payload FROM query_sessions_v1.records
                              WHERE kind=%s AND id=%s""", [kind, body["id"]]).fetchone()
                return {"record":record["payload"] if record else None}
            library = body["library"]
            require(library is None or valid_id(library), "QUERY_SESSION_LIBRARY_INVALID", 422)
            return {"rows":self._list(q, kind, library)}

    @staticmethod
    def _extend(q, owner):
        q("""UPDATE query_sessions_v1.gateway SET owner=%s,
             lease_until=clock_timestamp() + make_interval(secs=>%s) WHERE singleton""", [owner, LEASE_SECONDS])

    @staticmethod
    def _list(q, kind, library):
        selector = "" if library is None else " AND payload->>'library_id'=%s"
        values = [kind] if library is None else [kind, library]
        return q("""SELECT id,payload,updated_at FROM query_sessions_v1.records
                    WHERE kind=%s""" + selector + " ORDER BY updated_at DESC,id", values).fetchall()

    @staticmethod
    def _events(q, body):
        query, after, limit = (body[key] for key in ("query","after","limit"))
        require(valid_id(query) and type(after) is int and 0 <= after < 10**10
                and type(limit) is int and 1 <= limit <= 128, "QUERY_SESSION_EVENT_PAGE_INVALID", 422)
        return [row["payload"] for row in q("""SELECT payload FROM query_sessions_v1.records
              WHERE kind=%s AND id>%s AND id<%s ORDER BY id LIMIT %s""",
              [EVENT, f"{query}:{after:010}", f"{query};", limit]).fetchall()]
