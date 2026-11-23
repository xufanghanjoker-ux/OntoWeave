CREATE SCHEMA query_sessions_v1;

CREATE TABLE query_sessions_v1.schema_version (
    version integer PRIMARY KEY,
    sha256 text NOT NULL
);

CREATE TABLE query_sessions_v1.gateway (
    singleton boolean PRIMARY KEY CHECK (singleton),
    owner uuid,
    lease_until timestamptz,
    revision bigint NOT NULL DEFAULT 0,
    CHECK ((owner IS NULL) = (lease_until IS NULL))
);
INSERT INTO query_sessions_v1.gateway VALUES (true);

CREATE TABLE query_sessions_v1.records (
    kind text NOT NULL,
    id text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    updated_at text NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX query_sessions_kind_library ON query_sessions_v1.records
    (kind, (payload->>'library_id'), updated_at DESC, id);

CREATE TABLE query_sessions_v1.imports (
    snapshot_sha256 text PRIMARY KEY,
    records_sha256 text NOT NULL,
    counts jsonb NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
