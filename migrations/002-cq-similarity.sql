-- Isolated additive namespace. Existing CQ archive tables remain unchanged.
CREATE SCHEMA IF NOT EXISTS cq_similarity;
CREATE TABLE cq_similarity.schema_version(version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE cq_similarity.spaces(space_ref text PRIMARY KEY, identity jsonb NOT NULL);
CREATE TABLE cq_similarity.cache(
 library_ref text NOT NULL, space_ref text NOT NULL REFERENCES cq_similarity.spaces,
 input_sha text NOT NULL, values_json jsonb NOT NULL, embedding vector NOT NULL,
 vector_sha text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(library_ref,space_ref,input_sha));
CREATE TABLE cq_similarity.bindings(
 library_ref text NOT NULL, snapshot_ref text NOT NULL, cq_ref text NOT NULL,
 space_ref text NOT NULL, input_sha text NOT NULL,
 PRIMARY KEY(library_ref,snapshot_ref,cq_ref,space_ref),
 FOREIGN KEY(library_ref,space_ref,input_sha) REFERENCES cq_similarity.cache);
CREATE TABLE cq_similarity.plans(plan_ref text PRIMARY KEY, input_sha text NOT NULL, payload jsonb NOT NULL, payload_sha text NOT NULL);
