CREATE SCHEMA identity_v1;
CREATE TABLE identity_v1.schema_version(version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE identity_v1.libraries(
    library_ref text PRIMARY KEY,
    active_revision bigint,
    pending_revision bigint
);
CREATE TABLE identity_v1.revisions(
    library_ref text NOT NULL REFERENCES identity_v1.libraries,
    revision bigint NOT NULL,
    parent_revision bigint,
    identity_revision text NOT NULL UNIQUE,
    view_revision text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    activated_at timestamptz,
    PRIMARY KEY(library_ref, revision),
    FOREIGN KEY(library_ref, parent_revision) REFERENCES identity_v1.revisions,
    CHECK (revision > 0 AND (parent_revision = revision - 1 OR (revision = 1 AND parent_revision IS NULL)))
);
ALTER TABLE identity_v1.libraries
    ADD FOREIGN KEY(library_ref, active_revision) REFERENCES identity_v1.revisions,
    ADD FOREIGN KEY(library_ref, pending_revision) REFERENCES identity_v1.revisions;
CREATE TABLE identity_v1.prepared(
    library_ref text NOT NULL REFERENCES identity_v1.libraries,
    prepared_ref text PRIMARY KEY,
    payload jsonb NOT NULL
);
CREATE TABLE identity_v1.entities(
    library_ref text NOT NULL,
    entity_ref text NOT NULL,
    first_revision bigint NOT NULL,
    PRIMARY KEY(library_ref, entity_ref),
    FOREIGN KEY(library_ref, first_revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.statements(
    library_ref text NOT NULL,
    statement_ref text NOT NULL,
    first_revision bigint NOT NULL,
    candidate_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, statement_ref),
    FOREIGN KEY(library_ref, first_revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.occurrences(
    library_ref text NOT NULL,
    occurrence_ref text NOT NULL,
    home_entity_ref text NOT NULL,
    statement_ref text,
    item_ref text NOT NULL,
    role text NOT NULL CHECK(role IN ('DECLARATION','SUBJECT','OBJECT','QUALIFIER_ENTITY')),
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, occurrence_ref),
    FOREIGN KEY(library_ref, home_entity_ref) REFERENCES identity_v1.entities,
    FOREIGN KEY(library_ref, statement_ref) REFERENCES identity_v1.statements
);
CREATE INDEX identity_occurrence_item ON identity_v1.occurrences(library_ref, item_ref, role);
CREATE INDEX identity_occurrence_statement ON identity_v1.occurrences(library_ref, statement_ref);
CREATE INDEX identity_occurrence_home ON identity_v1.occurrences(library_ref, home_entity_ref);
CREATE TABLE identity_v1.previews(
    library_ref text NOT NULL REFERENCES identity_v1.libraries,
    preview_ref text PRIMARY KEY,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE identity_v1.decisions(
    library_ref text NOT NULL,
    decision_ref text NOT NULL,
    revision bigint NOT NULL,
    ordinal integer NOT NULL,
    request_ref text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY(library_ref, decision_ref),
    UNIQUE(library_ref, request_ref),
    UNIQUE(library_ref, revision, ordinal),
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.bindings(
    library_ref text NOT NULL,
    occurrence_ref text NOT NULL,
    revision bigint NOT NULL,
    entity_ref text NOT NULL,
    decision_ref text,
    PRIMARY KEY(library_ref, occurrence_ref, revision),
    FOREIGN KEY(library_ref, occurrence_ref) REFERENCES identity_v1.occurrences,
    FOREIGN KEY(library_ref, entity_ref) REFERENCES identity_v1.entities,
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions,
    FOREIGN KEY(library_ref, decision_ref) REFERENCES identity_v1.decisions
);
CREATE INDEX identity_bindings_entity ON identity_v1.bindings(library_ref, entity_ref, revision);
CREATE TABLE identity_v1.reviews(
    library_ref text NOT NULL,
    review_ref text NOT NULL,
    left_ref text NOT NULL,
    right_ref text NOT NULL,
    evidence_sha256 text NOT NULL,
    strategy text NOT NULL,
    first_revision bigint NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, review_ref),
    UNIQUE(library_ref, left_ref, right_ref, evidence_sha256, strategy),
    FOREIGN KEY(library_ref, left_ref) REFERENCES identity_v1.entities,
    FOREIGN KEY(library_ref, right_ref) REFERENCES identity_v1.entities,
    FOREIGN KEY(library_ref, first_revision) REFERENCES identity_v1.revisions,
    CHECK(left_ref < right_ref)
);
CREATE TABLE identity_v1.batch_results(
    library_ref text NOT NULL REFERENCES identity_v1.libraries,
    batch_ref text NOT NULL,
    prepared_ref text NOT NULL REFERENCES identity_v1.prepared,
    status text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, batch_ref)
);
CREATE TABLE identity_v1.name_vectors(
    library_ref text NOT NULL REFERENCES identity_v1.libraries,
    purpose text NOT NULL CHECK(purpose='ENTITY_NAME'),
    space_ref text NOT NULL,
    input_sha256 text NOT NULL,
    input_text text NOT NULL,
    embedding vector NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, purpose, space_ref, input_sha256)
);
CREATE TABLE identity_v1.publication_jobs(
    job_ref text PRIMARY KEY,
    library_ref text NOT NULL,
    revision bigint NOT NULL,
    status text NOT NULL CHECK(status IN ('PENDING','FAILED','APPLIED')),
    payload jsonb NOT NULL,
    UNIQUE(library_ref, revision),
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.active_views(
    library_ref text NOT NULL,
    revision bigint NOT NULL,
    graph_revision text NOT NULL UNIQUE,
    index_revision text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    PRIMARY KEY(library_ref, revision),
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.graph_rows(
    library_ref text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('NODE','STATEMENT','REVIEW')),
    row_ref text NOT NULL,
    revision bigint NOT NULL,
    payload jsonb,
    PRIMARY KEY(library_ref, kind, row_ref, revision),
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions
);
CREATE TABLE identity_v1.index_documents(
    library_ref text NOT NULL,
    entity_ref text NOT NULL,
    revision bigint NOT NULL,
    names text[] NOT NULL,
    payload jsonb,
    PRIMARY KEY(library_ref, entity_ref, revision),
    FOREIGN KEY(library_ref, entity_ref) REFERENCES identity_v1.entities,
    FOREIGN KEY(library_ref, revision) REFERENCES identity_v1.revisions
);
CREATE INDEX identity_index_names ON identity_v1.index_documents USING gin(names);
