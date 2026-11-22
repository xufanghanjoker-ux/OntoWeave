CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA retrieval_v1;
CREATE TABLE retrieval_v1.schema_version (version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE retrieval_v1.source_manifests (
  library_ref text NOT NULL REFERENCES publication_v1.libraries,
  source_manifest_ref text NOT NULL,
  body jsonb NOT NULL, body_sha text NOT NULL,
  PRIMARY KEY (library_ref, source_manifest_ref)
);
CREATE TABLE retrieval_v1.embedding_spaces (
  space_ref text PRIMARY KEY, body jsonb NOT NULL, body_sha text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  UNIQUE (space_ref, dimensions)
);
CREATE TABLE retrieval_v1.embedding_requests (
  library_ref text NOT NULL REFERENCES publication_v1.libraries, operation_ref text NOT NULL,
  request_sha text NOT NULL, body jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED','RETURNED','FAILED','UNKNOWN')),
  receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (library_ref, operation_ref)
);
CREATE TABLE retrieval_v1.embedding_claims (
  library_ref text NOT NULL, space_ref text NOT NULL REFERENCES retrieval_v1.embedding_spaces,
  profile_ref text NOT NULL, text_sha text NOT NULL, operation_ref text NOT NULL,
  PRIMARY KEY (library_ref, space_ref, profile_ref, text_sha),
  FOREIGN KEY (library_ref, operation_ref) REFERENCES retrieval_v1.embedding_requests
);
CREATE TABLE retrieval_v1.embedding_cache (
  library_ref text NOT NULL, space_ref text NOT NULL, profile_ref text NOT NULL, text_sha text NOT NULL,
  vector_ref text NOT NULL, dimensions integer NOT NULL, embedding vector NOT NULL,
  operation_ref text NOT NULL,
  CHECK (vector_dims(embedding) = dimensions AND vector_norm(embedding) > 0),
  PRIMARY KEY (library_ref, space_ref, profile_ref, text_sha),
  UNIQUE (library_ref, vector_ref, space_ref, profile_ref, text_sha),
  FOREIGN KEY (space_ref, dimensions) REFERENCES retrieval_v1.embedding_spaces (space_ref, dimensions),
  FOREIGN KEY (library_ref, operation_ref) REFERENCES retrieval_v1.embedding_requests
);
CREATE TABLE retrieval_v1.records (
  library_ref text NOT NULL REFERENCES publication_v1.libraries, record_version_ref text NOT NULL,
  pool text NOT NULL CHECK (pool IN ('SOURCE','KNOWLEDGE')),
  representation text NOT NULL CHECK (representation IN ('SOURCE','FACT','OPEN')),
  text_sha text NOT NULL, source_segment_ref text, body jsonb NOT NULL, body_sha text NOT NULL,
  PRIMARY KEY (library_ref, record_version_ref),
  UNIQUE (library_ref, record_version_ref, text_sha),
  CHECK ((representation = 'SOURCE') = (pool = 'SOURCE'))
);
CREATE TABLE retrieval_v1.indexes (
  library_ref text NOT NULL, index_revision text NOT NULL, index_descriptor_ref text NOT NULL,
  source_manifest_ref text NOT NULL, body jsonb NOT NULL, body_sha text NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (library_ref, index_revision),
  UNIQUE (library_ref, index_descriptor_ref),
  FOREIGN KEY (library_ref, source_manifest_ref) REFERENCES retrieval_v1.source_manifests
);
CREATE TABLE retrieval_v1.memberships (
  library_ref text NOT NULL, index_revision text NOT NULL, record_version_ref text NOT NULL,
  text_sha text NOT NULL, space_ref text, profile_ref text, vector_ref text,
  PRIMARY KEY (library_ref, index_revision, record_version_ref),
  FOREIGN KEY (library_ref, index_revision) REFERENCES retrieval_v1.indexes,
  FOREIGN KEY (library_ref, record_version_ref, text_sha) REFERENCES retrieval_v1.records (library_ref, record_version_ref, text_sha),
  FOREIGN KEY (library_ref, vector_ref, space_ref, profile_ref, text_sha)
    REFERENCES retrieval_v1.embedding_cache (library_ref, vector_ref, space_ref, profile_ref, text_sha)
);
CREATE TABLE retrieval_v1.historical_certifications (
  library_ref text NOT NULL, view_revision text NOT NULL, index_descriptor_ref text NOT NULL,
  manifest_sha text NOT NULL, descriptor_sha text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (library_ref, view_revision, index_descriptor_ref),
  FOREIGN KEY (library_ref, view_revision) REFERENCES publication_v1.confirmations,
  FOREIGN KEY (library_ref, index_descriptor_ref) REFERENCES retrieval_v1.indexes (library_ref, index_descriptor_ref)
);
CREATE TABLE retrieval_v1.job_preparations (
  library_ref text NOT NULL, job_ref text NOT NULL, body jsonb NOT NULL, body_sha text NOT NULL,
  PRIMARY KEY (library_ref,job_ref),
  FOREIGN KEY (library_ref,job_ref) REFERENCES publication_v1.jobs
);
CREATE TABLE retrieval_v1.rerank_requests (
  library_ref text NOT NULL REFERENCES publication_v1.libraries, operation_ref text NOT NULL,
  request_sha text NOT NULL, body jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED','RETURNED','FAILED','UNKNOWN')),
  receipt jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (library_ref,operation_ref)
);
