CREATE SCHEMA ontology_v1;

CREATE TABLE ontology_v1.schema_version (
    version integer PRIMARY KEY,
    sha256 text NOT NULL
);

CREATE TABLE ontology_v1.revisions (
    library_ref text NOT NULL,
    ontology_revision text NOT NULL,
    parent_revision text,
    identity_revision text NOT NULL,
    run_ref text NOT NULL,
    base_view_revision text,
    input_sha256 text NOT NULL,
    result_sha256 text NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (library_ref, ontology_revision),
    UNIQUE (library_ref, run_ref),
    FOREIGN KEY (library_ref, parent_revision)
        REFERENCES ontology_v1.revisions (library_ref, ontology_revision)
);

CREATE TABLE ontology_v1.definitions (
    library_ref text NOT NULL,
    definition_ref text NOT NULL,
    definition_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('TYPE','RELATION','ATTRIBUTE')),
    label text NOT NULL,
    definition_status text NOT NULL CHECK (definition_status IN ('PROVISIONAL','ADOPTED','RETIRED')),
    content_sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, definition_ref)
);
CREATE INDEX ontology_definition_key ON ontology_v1.definitions (library_ref, definition_key);
CREATE INDEX ontology_definition_label ON ontology_v1.definitions (library_ref, lower(label));

CREATE TABLE ontology_v1.definition_supports (
    library_ref text NOT NULL,
    ontology_revision text NOT NULL,
    definition_ref text NOT NULL,
    statement_ref text NOT NULL,
    source_ref text NOT NULL,
    support_sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, ontology_revision, definition_ref, support_sha256),
    FOREIGN KEY (library_ref, ontology_revision) REFERENCES ontology_v1.revisions,
    FOREIGN KEY (library_ref, definition_ref) REFERENCES ontology_v1.definitions
);
CREATE INDEX ontology_support_source ON ontology_v1.definition_supports (library_ref, source_ref);
CREATE INDEX ontology_support_statement ON ontology_v1.definition_supports (library_ref, statement_ref);

CREATE TABLE ontology_v1.alignment_signatures (
    library_ref text NOT NULL,
    signature_ref text NOT NULL,
    basis_sha256 text NOT NULL,
    shape_key text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, signature_ref, basis_sha256)
);

CREATE TABLE ontology_v1.bindings (
    library_ref text NOT NULL,
    binding_ref text NOT NULL,
    signature_ref text NOT NULL,
    basis_sha256 text NOT NULL,
    definition_ref text,
    binding_state text NOT NULL CHECK (binding_state IN ('BOUND','OPEN','NEEDS_REVIEW')),
    direction text CHECK (direction IN ('FORWARD','REVERSE')),
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, binding_ref),
    FOREIGN KEY (library_ref, signature_ref, basis_sha256) REFERENCES ontology_v1.alignment_signatures,
    FOREIGN KEY (library_ref, definition_ref) REFERENCES ontology_v1.definitions
);
CREATE INDEX ontology_binding_definition ON ontology_v1.bindings (library_ref, definition_ref);

CREATE TABLE ontology_v1.statement_assignments (
    library_ref text NOT NULL,
    ontology_revision text NOT NULL,
    statement_ref text NOT NULL,
    component_role text NOT NULL CHECK (component_role IN ('MAIN_PROPERTY','SUBJECT_TYPE','OBJECT_TYPE','QUALIFIER_ROLE')),
    component_key text NOT NULL,
    target_occurrence_ref text,
    qualifier_position integer,
    binding_ref text NOT NULL,
    payload jsonb NOT NULL,
    CHECK ((component_role IN ('SUBJECT_TYPE','OBJECT_TYPE')) = (target_occurrence_ref IS NOT NULL)),
    CHECK ((component_role = 'QUALIFIER_ROLE') = (qualifier_position IS NOT NULL)),
    CHECK (qualifier_position >= 0),
    PRIMARY KEY (library_ref, ontology_revision, statement_ref, component_key),
    FOREIGN KEY (library_ref, ontology_revision) REFERENCES ontology_v1.revisions,
    FOREIGN KEY (library_ref, binding_ref) REFERENCES ontology_v1.bindings
);
CREATE UNIQUE INDEX ontology_one_main ON ontology_v1.statement_assignments
    (library_ref, ontology_revision, statement_ref) WHERE component_role = 'MAIN_PROPERTY';
CREATE INDEX ontology_statement_impact ON ontology_v1.statement_assignments (library_ref, statement_ref);
CREATE INDEX ontology_assignment_binding ON ontology_v1.statement_assignments (library_ref, binding_ref);

CREATE TABLE ontology_v1.constraint_proposals (
    library_ref text NOT NULL,
    ontology_revision text NOT NULL,
    proposal_ref text NOT NULL,
    definition_ref text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, ontology_revision, proposal_ref),
    FOREIGN KEY (library_ref, ontology_revision) REFERENCES ontology_v1.revisions,
    FOREIGN KEY (library_ref, definition_ref) REFERENCES ontology_v1.definitions
);

CREATE TABLE ontology_v1.run_receipts (
    library_ref text NOT NULL,
    run_ref text NOT NULL,
    receipt_key text NOT NULL,
    sha256 text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (library_ref, run_ref, receipt_key)
);
