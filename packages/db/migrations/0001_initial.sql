-- 0001_initial: core tables for projects, authoring, publication, jobs,
-- devices and state backups. See docs/database.md for the meaning of each
-- table and the invariants enforced here.
--
-- Migrations are append-only. Never edit a migration after it has run
-- anywhere; the migrator refuses a changed checksum.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity-provider subject, namespaced by provider, e.g. 'dev:alice'.
  external_id   text NOT NULL UNIQUE,
  display_name  text,
  preferences   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  -- Advanced only by the packaging job, after the package is durable.
  current_release_id  uuid,
  last_opened_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_recent ON projects (owner_id, updated_at DESC);

CREATE TABLE uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  object_key   text NOT NULL UNIQUE,
  filename     text,
  media_type   text NOT NULL,
  byte_size    bigint,
  sha256       text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- receiving: bytes streaming; stored: in object storage, preparation queued;
  -- ready: prepared for authoring; rejected/failed: unusable (see error).
  status       text NOT NULL DEFAULT 'receiving'
               CHECK (status IN ('receiving', 'stored', 'ready', 'rejected', 'failed')),
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_owner ON uploads (owner_id, created_at DESC);

-- One authoring thread per project for now; messages reference uploads by ID.
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body            text NOT NULL,
  attachment_ids  uuid[] NOT NULL DEFAULT '{}',
  job_id          uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_project ON messages (project_id, created_at);

CREATE TABLE revisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Per-project counter shown to people ("revision 3").
  number             integer NOT NULL CHECK (number > 0),
  base_revision_id   uuid REFERENCES revisions(id),
  definition         jsonb NOT NULL,
  format_version     integer NOT NULL,
  minimum_runtime_version text,
  validation_status  text NOT NULL CHECK (validation_status IN ('valid', 'invalid')),
  validation_issues  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- client: submitted through the API (bring-your-own assistant, tests);
  -- model: produced by a generation job.
  source             text NOT NULL CHECK (source IN ('client', 'model')),
  job_id             uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number),
  UNIQUE (id, project_id)
);

-- Program-detected impacts of a candidate relative to its base. Publication is
-- blocked while a review with impacts is not accepted. Acceptance is bound to
-- this exact candidate/base pair.
CREATE TABLE change_reviews (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  candidate_revision_id  uuid NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  base_revision_id       uuid REFERENCES revisions(id),
  impacts                jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision               text NOT NULL DEFAULT 'pending'
                         CHECK (decision IN ('pending', 'accepted', 'rejected')),
  decided_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_revision_id)
);

-- Applet-specific, content-addressed assets (diagram crops etc.).
CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key  text NOT NULL,
  media_type  text NOT NULL,
  byte_size   bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, sha256)
);

CREATE TABLE releases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id         uuid NOT NULL,
  -- The release the publisher expected to replace (NULL = first release).
  -- The pointer advances only if it still matches.
  base_release_id     uuid REFERENCES releases(id),
  -- pending: packaging queued/running; ready: package durable and published;
  -- superseded: another release won the race; failed: packaging gave up.
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'ready', 'superseded', 'failed')),
  package_key         text,
  package_sha256      text CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  package_bytes       bigint,
  minimum_runtime_version text,
  error               jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  FOREIGN KEY (revision_id, project_id) REFERENCES revisions(id, project_id),
  -- A ready release always has a complete package description.
  CHECK (status <> 'ready' OR (package_key IS NOT NULL AND package_sha256 IS NOT NULL AND package_bytes IS NOT NULL))
);
CREATE INDEX releases_project ON releases (project_id, created_at DESC);

ALTER TABLE projects
  ADD CONSTRAINT projects_current_release_fk
  FOREIGN KEY (current_release_id) REFERENCES releases(id);

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('prepare_upload', 'generate_revision', 'package_release')),
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  result            jsonb,
  error             jsonb,
  progress          jsonb,
  usage             jsonb,
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after         timestamptz NOT NULL DEFAULT now(),
  lease_owner       text,
  lease_expires_at  timestamptz,
  cancel_requested  boolean NOT NULL DEFAULT false,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (owner_id, idempotency_key),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- The claim query scans only claimable rows.
CREATE INDEX jobs_claimable ON jobs (run_after, created_at) WHERE status = 'queued';
CREATE INDEX jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_owner ON jobs (owner_id, created_at DESC);

-- One-use, short-lived codes shown in the authoring client and entered on (or
-- scanned by) the glasses. Only an HMAC of the code is stored.
CREATE TABLE pairing_codes (
  code_hash   text PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         text NOT NULL DEFAULT 'Glasses',
  -- HMAC-SHA256(SESSION_SECRET, token); the token itself is never stored.
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX devices_owner ON devices (owner_id);

-- Every state backup attempt, accepted or not, so conflicting snapshots are
-- retained rather than overwritten. operation_id makes retries idempotent.
CREATE TABLE state_backups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  operation_id     text NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 128),
  sequence         bigint NOT NULL CHECK (sequence >= 0),
  revision_id      uuid,
  schema_version   integer NOT NULL,
  expected_server_version integer NOT NULL,
  snapshot         jsonb NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('accepted', 'conflict', 'stale')),
  -- The server version this backup created (accepted only).
  server_version   integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, device_id, operation_id)
);

-- The current accepted backup per project; the row lock serializes writers.
CREATE TABLE project_state (
  project_id      uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  server_version  integer NOT NULL,
  backup_id       uuid NOT NULL REFERENCES state_backups(id),
  device_id       uuid NOT NULL,
  sequence        bigint NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
