CREATE TABLE publication_v1.workspace_registry (
    library_ref text PRIMARY KEY REFERENCES publication_v1.libraries(library_ref),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    actor_ref text NOT NULL,
    operation_ref text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor_ref, operation_ref)
);
