ALTER TABLE publication_v1.workspace_registry
    ADD COLUMN initial_title text,
    ADD COLUMN workspace_state text NOT NULL DEFAULT 'ACTIVE'
        CHECK (workspace_state IN ('ACTIVE','ARCHIVED')),
    ADD COLUMN workspace_revision bigint NOT NULL DEFAULT 1 CHECK (workspace_revision > 0);

UPDATE publication_v1.workspace_registry SET initial_title=title;
ALTER TABLE publication_v1.workspace_registry ALTER COLUMN initial_title SET NOT NULL;

CREATE TABLE publication_v1.workspace_operations (
    actor_ref text NOT NULL,
    operation_ref text NOT NULL,
    library_ref text NOT NULL REFERENCES publication_v1.workspace_registry,
    request_sha text NOT NULL,
    response jsonb NOT NULL,
    PRIMARY KEY (actor_ref,operation_ref)
);
