CREATE SCHEMA publication_v1;

CREATE TABLE publication_v1.libraries (
    library_ref text PRIMARY KEY,
    active_view_revision text,
    pending_view_revision text,
    activation_seq bigint NOT NULL DEFAULT 0 CHECK (activation_seq >= 0)
);
CREATE TABLE publication_v1.jobs (
    library_ref text NOT NULL REFERENCES publication_v1.libraries,
    job_ref text NOT NULL,
    request_ref text NOT NULL,
    input_sha text NOT NULL,
    base_view_revision text,
    target_view_revision text,
    status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','UNKNOWN_HOLD','CANCELLED')),
    request jsonb NOT NULL,
    failure jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (library_ref, job_ref),
    UNIQUE (library_ref, request_ref)
);
CREATE TABLE publication_v1.manifests (
    library_ref text NOT NULL REFERENCES publication_v1.libraries,
    view_revision text NOT NULL,
    parent_view_revision text,
    activation_seq bigint NOT NULL CHECK (activation_seq > 0),
    job_ref text NOT NULL,
    body jsonb NOT NULL,
    body_sha text NOT NULL,
    staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (library_ref, view_revision),
    UNIQUE (library_ref, activation_seq),
    UNIQUE (library_ref, job_ref),
    FOREIGN KEY (library_ref, parent_view_revision) REFERENCES publication_v1.manifests,
    FOREIGN KEY (library_ref, job_ref) REFERENCES publication_v1.jobs
);
CREATE TABLE publication_v1.confirmations (
    library_ref text NOT NULL,
    view_revision text NOT NULL,
    activated_at timestamptz NOT NULL,
    PRIMARY KEY (library_ref, view_revision),
    FOREIGN KEY (library_ref, view_revision) REFERENCES publication_v1.manifests
);
CREATE INDEX publication_confirmed_time ON publication_v1.confirmations(library_ref,activated_at);
ALTER TABLE publication_v1.libraries
    ADD FOREIGN KEY (library_ref, active_view_revision) REFERENCES publication_v1.confirmations,
    ADD FOREIGN KEY (library_ref, pending_view_revision) REFERENCES publication_v1.manifests;
CREATE TABLE publication_v1.job_steps (
    library_ref text NOT NULL,
    job_ref text NOT NULL,
    step text NOT NULL CHECK (step IN ('FACT','GRAPH','INDEX')),
    input_sha text NOT NULL,
    output_sha text NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (library_ref, job_ref, step),
    FOREIGN KEY (library_ref, job_ref) REFERENCES publication_v1.jobs
);
CREATE TABLE publication_v1.projection_delta (
    library_ref text NOT NULL,
    job_ref text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('NODE','EDGE','STATEMENT','SOURCE','FACT','DEFINITION','REVIEW','ENTITY_NAME','FACT_LEXICAL','SOURCE_LEXICAL','FACT_VECTOR','SOURCE_VECTOR')),
    object_ref text NOT NULL,
    body jsonb,
    PRIMARY KEY (library_ref, job_ref, kind, object_ref),
    FOREIGN KEY (library_ref, job_ref) REFERENCES publication_v1.jobs
);
CREATE TABLE publication_v1.changes (
    library_ref text NOT NULL,
    change_ref text NOT NULL,
    view_revision text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (library_ref, change_ref),
    UNIQUE (library_ref, view_revision),
    FOREIGN KEY (library_ref, view_revision) REFERENCES publication_v1.manifests
);
CREATE TABLE publication_v1.previews (
    library_ref text NOT NULL,
    preview_ref text NOT NULL,
    base_view_revision text NOT NULL,
    actor text NOT NULL,
    target_ref text NOT NULL,
    request_sha text NOT NULL,
    plan jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (library_ref, preview_ref),
    FOREIGN KEY (library_ref, base_view_revision) REFERENCES publication_v1.confirmations
);
CREATE TABLE publication_v1.decisions (
    library_ref text NOT NULL,
    decision_ref text NOT NULL,
    review_ref text,
    basis_view_revision text NOT NULL,
    request_ref text NOT NULL,
    request_sha text NOT NULL,
    actor text NOT NULL,
    request jsonb NOT NULL,
    plan jsonb,
    job_ref text,
    status text NOT NULL CHECK (status IN ('SAVED','APPLIED','SUPERSEDED')),
    supersedes text,
    PRIMARY KEY (library_ref, decision_ref),
    UNIQUE (library_ref, request_ref),
    UNIQUE (library_ref, job_ref),
    FOREIGN KEY (library_ref, basis_view_revision) REFERENCES publication_v1.confirmations,
    FOREIGN KEY (library_ref, job_ref) REFERENCES publication_v1.jobs,
    FOREIGN KEY (library_ref, supersedes) REFERENCES publication_v1.decisions
);
CREATE INDEX publication_review_decisions ON publication_v1.decisions(library_ref,review_ref)
    WHERE status = 'SAVED';
CREATE TABLE publication_v1.review_deferrals (
    library_ref text NOT NULL,
    review_ref text NOT NULL,
    basis_view_revision text NOT NULL,
    request_ref text NOT NULL,
    request_sha text NOT NULL,
    actor text NOT NULL,
    intent jsonb NOT NULL,
    PRIMARY KEY (library_ref, request_ref),
    UNIQUE (library_ref, review_ref, basis_view_revision),
    FOREIGN KEY (library_ref, basis_view_revision) REFERENCES publication_v1.confirmations
);
CREATE TABLE publication_v1.feedback (
    library_ref text NOT NULL,
    operation_ref text NOT NULL,
    request_sha text NOT NULL,
    view_revision text NOT NULL,
    actor text NOT NULL,
    body jsonb NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (library_ref, operation_ref),
    FOREIGN KEY (library_ref, view_revision) REFERENCES publication_v1.confirmations
);
CREATE TABLE publication_v1.outbox (
    stream_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    library_ref text NOT NULL REFERENCES publication_v1.libraries,
    event_type text NOT NULL,
    run_ref text,
    job_ref text,
    view_revision text,
    change_ref text,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload jsonb NOT NULL,
    FOREIGN KEY (library_ref, job_ref) REFERENCES publication_v1.jobs,
    FOREIGN KEY (library_ref, view_revision) REFERENCES publication_v1.confirmations
);
CREATE INDEX publication_outbox_library ON publication_v1.outbox(library_ref, stream_seq);
CREATE TABLE publication_v1.builds (
    library_ref text NOT NULL REFERENCES publication_v1.libraries,
    run_ref text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (library_ref, run_ref)
);
