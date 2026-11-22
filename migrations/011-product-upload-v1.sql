CREATE SCHEMA product_upload_v1;

CREATE TABLE product_upload_v1.uploads (
    library_ref text PRIMARY KEY REFERENCES publication_v1.libraries,
    run_ref text NOT NULL UNIQUE,
    actor_ref text NOT NULL,
    operation_ref text NOT NULL,
    input_sha256 text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (library_ref, run_ref) REFERENCES publication_v1.builds
);

CREATE TABLE product_upload_v1.documents (
    run_ref text NOT NULL REFERENCES product_upload_v1.uploads(run_ref),
    ordinal integer NOT NULL,
    payload bytea NOT NULL,
    PRIMARY KEY (run_ref, ordinal)
);
