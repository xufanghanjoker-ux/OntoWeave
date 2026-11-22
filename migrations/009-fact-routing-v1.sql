CREATE SCHEMA IF NOT EXISTS fact_routing_v1;

CREATE TABLE fact_routing_v1.schema_version (
    version integer PRIMARY KEY,
    sha256 text NOT NULL
);

CREATE TABLE fact_routing_v1.bundles (
    library_ref text NOT NULL,
    bundle_ref text NOT NULL,
    operation_ref text NOT NULL,
    body_sha text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, bundle_ref),
    UNIQUE (library_ref, operation_ref)
);

CREATE TABLE fact_routing_v1.receipts (
    library_ref text NOT NULL,
    fact_revision text NOT NULL,
    bundle_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_revision),
    UNIQUE (library_ref, bundle_ref),
    FOREIGN KEY (library_ref, bundle_ref) REFERENCES fact_routing_v1.bundles
);

CREATE TABLE fact_routing_v1.group_snapshots (
    library_ref text NOT NULL,
    fact_revision text NOT NULL,
    group_key text NOT NULL,
    body_sha text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_revision, group_key),
    FOREIGN KEY (library_ref, fact_revision) REFERENCES fact_routing_v1.receipts
);

CREATE INDEX fact_routing_group_lookup
    ON fact_routing_v1.group_snapshots (library_ref, group_key, fact_revision);

CREATE TABLE fact_routing_v1.routing_records (
    library_ref text NOT NULL,
    fact_revision text NOT NULL,
    statement_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_revision, statement_ref),
    FOREIGN KEY (library_ref, fact_revision) REFERENCES fact_routing_v1.receipts
);

CREATE TABLE fact_routing_v1.fact_versions (
    library_ref text NOT NULL,
    fact_version_ref text NOT NULL,
    fact_ref text NOT NULL,
    group_key text NOT NULL,
    fact_revision text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_version_ref),
    FOREIGN KEY (library_ref, fact_revision) REFERENCES fact_routing_v1.receipts
);

CREATE INDEX fact_routing_version_history
    ON fact_routing_v1.fact_versions (library_ref, group_key, fact_ref);

CREATE TABLE fact_routing_v1.fact_closures (
    library_ref text NOT NULL,
    fact_revision text NOT NULL,
    fact_version_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_revision, fact_version_ref),
    FOREIGN KEY (library_ref, fact_revision) REFERENCES fact_routing_v1.receipts,
    FOREIGN KEY (library_ref, fact_version_ref) REFERENCES fact_routing_v1.fact_versions
);

CREATE TABLE fact_routing_v1.support_records (
    library_ref text NOT NULL,
    fact_revision text NOT NULL,
    statement_ref text NOT NULL,
    fact_version_ref text NOT NULL,
    group_key text NOT NULL,
    support_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, fact_revision, statement_ref, fact_version_ref, support_ref),
    FOREIGN KEY (library_ref, fact_revision, group_key) REFERENCES fact_routing_v1.group_snapshots
);

CREATE INDEX fact_routing_statement_groups
    ON fact_routing_v1.support_records (library_ref, statement_ref, fact_revision, group_key);

CREATE TABLE fact_routing_v1.review_basis (
    library_ref text NOT NULL,
    review_ref text NOT NULL,
    basis_version text NOT NULL,
    fact_revision text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, review_ref, basis_version, fact_revision),
    FOREIGN KEY (library_ref, fact_revision) REFERENCES fact_routing_v1.receipts
);
