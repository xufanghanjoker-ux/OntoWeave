CREATE TABLE identity_v1.product_source_scopes (
    library_ref text NOT NULL,
    revision bigint NOT NULL,
    source_snapshot_ref text NOT NULL,
    occurrence_refs text[] NOT NULL,
    statement_refs text[] NOT NULL,
    PRIMARY KEY (library_ref, revision),
    FOREIGN KEY (library_ref, revision) REFERENCES identity_v1.revisions
);
