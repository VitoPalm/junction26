-- Native background recording outlives short Clerk JWTs. Tokens are scoped in API middleware.
CREATE TABLE note_recorder_sessions (
  token_hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX note_recorder_sessions_owner ON note_recorder_sessions(owner_id);
