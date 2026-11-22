CREATE TABLE identity_v1.continuations (
  library_ref text NOT NULL,
  prepared_ref text NOT NULL,
  continuation_id text NOT NULL,
  selection jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED', 'SETTLED')),
  result jsonb,
  PRIMARY KEY (library_ref, prepared_ref, continuation_id)
);
