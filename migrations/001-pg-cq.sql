-- CQ archive only. Existing SQLite and product run pointers are untouched.
CREATE TABLE IF NOT EXISTS pg_cq_schema_migrations(version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE pg_cq_archives (
 archive_id text PRIMARY KEY, run_id text NOT NULL, content_sha256 text NOT NULL CHECK(length(content_sha256)=64), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pg_cq_artifacts (
 archive_id text NOT NULL REFERENCES pg_cq_archives, name text NOT NULL, role text NOT NULL,
 bytes bytea NOT NULL, bytes_sha256 text NOT NULL CHECK(length(bytes_sha256)=64),
 PRIMARY KEY(archive_id,name)
);
CREATE TABLE pg_cq_documents (
 archive_id text NOT NULL REFERENCES pg_cq_archives, doc_ref text NOT NULL, title text NOT NULL,
 PRIMARY KEY(archive_id,doc_ref)
);
CREATE TABLE pg_cq_versions (
 archive_id text NOT NULL, doc_ref text NOT NULL, revision text NOT NULL,
 content text NOT NULL, content_sha256 text NOT NULL, original_sha256 text, source_payload text NOT NULL,
 PRIMARY KEY(archive_id,doc_ref,revision), FOREIGN KEY(archive_id,doc_ref) REFERENCES pg_cq_documents
);
CREATE TABLE pg_cq_blocks (
 archive_id text NOT NULL, chunk_ref text NOT NULL, doc_ref text NOT NULL, revision text NOT NULL,
 plan_ref text NOT NULL, manifest_ref text NOT NULL, material text NOT NULL, material_sha256 text NOT NULL,
 token_count integer NOT NULL CHECK(token_count>=0 AND token_count<=5000), payload text NOT NULL,
 PRIMARY KEY(archive_id,chunk_ref), FOREIGN KEY(archive_id,doc_ref,revision) REFERENCES pg_cq_versions
);
CREATE TABLE pg_cq_units (
 archive_id text NOT NULL, chunk_ref text NOT NULL, unit_ref text NOT NULL, label text NOT NULL, ordinal integer NOT NULL,
 text text NOT NULL, text_sha256 text NOT NULL, context text NOT NULL, source_items jsonb NOT NULL, fragment text,
 payload text NOT NULL, PRIMARY KEY(archive_id,chunk_ref,unit_ref),
 UNIQUE(archive_id,chunk_ref,label), UNIQUE(archive_id,chunk_ref,ordinal),
 FOREIGN KEY(archive_id,chunk_ref) REFERENCES pg_cq_blocks
);
CREATE TABLE pg_cq_questions (
 archive_id text NOT NULL REFERENCES pg_cq_archives, kind text NOT NULL CHECK(kind IN ('LOCAL','AGGREGATE')),
 cq_ref text NOT NULL, question text NOT NULL CHECK(length(trim(question))>0), range_status text NOT NULL,
 payload text NOT NULL, PRIMARY KEY(archive_id,kind,cq_ref)
);
CREATE TABLE pg_cq_members (
 archive_id text NOT NULL, aggregate_ref text NOT NULL, local_ref text NOT NULL,
 aggregate_kind text NOT NULL DEFAULT 'AGGREGATE' CHECK(aggregate_kind='AGGREGATE'),
 local_kind text NOT NULL DEFAULT 'LOCAL' CHECK(local_kind='LOCAL'),
 PRIMARY KEY(archive_id,aggregate_ref,local_ref),
 FOREIGN KEY(archive_id,aggregate_kind,aggregate_ref) REFERENCES pg_cq_questions(archive_id,kind,cq_ref),
 FOREIGN KEY(archive_id,local_kind,local_ref) REFERENCES pg_cq_questions(archive_id,kind,cq_ref)
);
CREATE TABLE pg_cq_ranges (
 archive_id text NOT NULL, question_kind text NOT NULL, cq_ref text NOT NULL,
 range_kind text NOT NULL CHECK(range_kind IN ('EXACT','FALLBACK')), ordinal integer NOT NULL,
 chunk_ref text, start_label text, end_label text, start_unit_ref text, end_unit_ref text,
 validation_status text NOT NULL CHECK(validation_status IN ('VALID','QUARANTINED')), validation_error text, payload text NOT NULL,
 PRIMARY KEY(archive_id,question_kind,cq_ref,range_kind,ordinal),
 FOREIGN KEY(archive_id,question_kind,cq_ref) REFERENCES pg_cq_questions(archive_id,kind,cq_ref),
 FOREIGN KEY(archive_id,chunk_ref) REFERENCES pg_cq_blocks,
 FOREIGN KEY(archive_id,chunk_ref,start_unit_ref) REFERENCES pg_cq_units(archive_id,chunk_ref,unit_ref),
 FOREIGN KEY(archive_id,chunk_ref,end_unit_ref) REFERENCES pg_cq_units(archive_id,chunk_ref,unit_ref),
 CHECK((validation_status='VALID' AND chunk_ref IS NOT NULL AND start_unit_ref IS NOT NULL AND end_unit_ref IS NOT NULL AND validation_error IS NULL)
 OR (validation_status='QUARANTINED' AND validation_error IS NOT NULL AND chunk_ref IS NULL))
);
CREATE TABLE pg_cq_range_units (
 archive_id text NOT NULL, question_kind text NOT NULL, cq_ref text NOT NULL, range_kind text NOT NULL, range_ordinal integer NOT NULL,
 unit_ordinal integer NOT NULL, chunk_ref text NOT NULL, unit_ref text NOT NULL,
 PRIMARY KEY(archive_id,question_kind,cq_ref,range_kind,range_ordinal,unit_ordinal),
 FOREIGN KEY(archive_id,question_kind,cq_ref,range_kind,range_ordinal) REFERENCES pg_cq_ranges(archive_id,question_kind,cq_ref,range_kind,ordinal),
 FOREIGN KEY(archive_id,chunk_ref,unit_ref) REFERENCES pg_cq_units(archive_id,chunk_ref,unit_ref)
);
CREATE TABLE pg_cq_records (
 archive_id text NOT NULL REFERENCES pg_cq_archives, kind text NOT NULL, record_key text NOT NULL,
 payload text NOT NULL, record_sha256 text NOT NULL, PRIMARY KEY(archive_id,kind,record_key)
);
-- No real embedding storage/recall is introduced. Synthetic vector smoke is session-local.
