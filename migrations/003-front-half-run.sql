-- Isolated live CQ host records. Frozen CQ archives remain owned by PGCQStore.
CREATE SCHEMA front_half;
CREATE TABLE front_half.schema_version (version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE front_half.runs (run_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE front_half.records (
 run_id text NOT NULL REFERENCES front_half.runs, kind text NOT NULL, key text NOT NULL,
 payload jsonb NOT NULL, payload_sha text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(run_id,kind,key)
);
CREATE TABLE front_half.history (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id text NOT NULL REFERENCES front_half.runs,
 kind text NOT NULL, key text NOT NULL, payload jsonb NOT NULL, payload_sha text NOT NULL,
 saved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
