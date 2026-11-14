-- External assistant submissions are atomic and replayable across process restarts.
-- Keys are scoped to the owner and this endpoint; never expire them implicitly.
CREATE TABLE assistant_draft_operations (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 8 AND 128),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, operation_id)
);
