# Database

Status: **implemented** in `packages/db` (2026-11-14): schema in
`packages/db/migrations/`, typed queries in `packages/db/src/queries/`. Target:
Aiven PostgreSQL (provisioned; current resource details in
[infrastructure-setup.md](infrastructure-setup.md)); developed and tested on
PostgreSQL 18.

## Principles

- **Plain SQL, no ORM.** Queries are small typed functions. Results are
  converted to camelCase records (`packages/db/src/rows.ts`).
- **Ownership in every query.** Functions that read user data take `ownerId` and
  filter on it, so a forgotten check shows up as a missing argument. Functions
  without an owner filter are named or commented as internal (worker-only).
- **The database enforces invariants**, not just the code: foreign keys, CHECK
  constraints on every status column, uniqueness for idempotency, and "running
  ⇔ leased" on jobs.
- **No large binaries.** Files and packages live in object storage; rows hold
  the key, size and SHA-256.
- **PgBouncer-safe.** Only unnamed statements, no session state in request
  paths. The exception is migrations: they use a session advisory lock, so run
  them on a **direct** connection (`MIGRATION_DATABASE_URL`).

## Tables

| Table | Purpose | Key invariants |
| --- | --- | --- |
| `users` | One row per identity (`external_id`, e.g. `dev:alice`) | `external_id` unique |
| `projects` | A user's applet: title, `current_release_id`, `last_opened_at` | The pointer only moves inside the packaging transaction |
| `uploads` | Authoring files: object key, type, size, SHA-256, status | Status ∈ receiving, stored, ready, rejected, failed |
| `messages` | Authoring thread (one per project for now) | Linked to the generation job |
| `revisions` | Immutable candidate definitions, numbered per project | `(project_id, number)` unique; numbers assigned under the project lock |
| `change_reviews` | Program-detected data-loss findings for a candidate | One per candidate; publish blocks recorded unaccepted impacts. Assistant drafts create records; managed/direct revision coverage remains incomplete |
| `assets` | Reserved content-addressed image records | `(project_id, sha256)` unique; current pipeline embeds resolved bytes in revision definitions instead |
| `releases` | Publication attempts | A `ready` release has key + hash + size (CHECK); revision must belong to the same project (composite FK) |
| `jobs` | Durable queue; see [jobs.md](jobs.md) | `(owner_id, idempotency_key)` unique; `running` ⇔ lease set |
| `pairing_codes` | One-use device pairing codes (HMAC only) | Expiry + `used_at` checked atomically |
| `devices` | Paired glasses sessions (token HMAC only) | `token_hash` unique; `revoked_at` |
| `state_backups` | Every backup attempt, including refused ones | `(project_id, device_id, operation_id)` unique (idempotency) |
| `project_state` | Pointer to the current accepted backup + `server_version` | One row per project |
| `voice_notes` | Voice notes on applet pages ([voice-notes.md](voice-notes.md)): anchor (`view_id`, `step_id`), page label, values at start, status, audio key/type/hash/size, transcript | Client-generated `id`; audio key ⇔ hash (CHECK); `uploaded`/`transcribing`/`transcribed`/`failed` need audio; only notes without audio can be `discarded`; edited transcripts are never overwritten (`transcript_edited`) |
| `note_recorder_sessions` | Native background recorder credentials (`0004_note_recorder_sessions.sql`) | Token HMAC only; owner FK; 12-hour expiry; owner-scoped revocation; API permits only recorder events, confirmation, discard, live check and upload |

What's not here on purpose: chat transcripts and documents in packages; any
"conversation" table (there's one thread per project until the UX needs more);
sessions for users (owned by Clerk).

Clerk identities use `external_id = 'clerk:' + JSON.stringify([issuer, subject])`.
Web sessions from the same instance/user reuse one internal user, independent of
session ID and email. Dev identities remain separate; there is no automatic
account merge or transfer of their projects/devices. No schema migration is
needed for this identity mapping.

## Migrations

- Files: `packages/db/migrations/NNNN_name.sql`, applied in order, each in its
  own transaction, recorded in `schema_migrations` with a SHA-256 checksum.
- **Append-only.** Never edit an applied migration: the migrator refuses to run
  if a checksum changed. It also refuses if the database has migrations the
  build doesn't know (an older build deployed over a newer schema).
- Concurrency: the migrator takes `pg_advisory_lock`, so API and worker can both
  run with `MIGRATE_ON_START=true`. One waits while the other migrates.
- Run manually: `npm run migrate` (uses `.env.backend.local`), or in a
  container: `SERVICE_ROLE=migrate`.
- Aiven Runtime has no pre-deploy hook, so in deployment the API migrates on
  start (`MIGRATE_ON_START=true` in `compose.yaml`).
- Write migrations to be compatible with the previous build still running
  (expand, then contract in a later migration), because the API and worker
  redeploy separately.

## Testing

`packages/db/src/testing.ts` creates a throwaway database per test file on the
server in `TEST_DATABASE_URL`, migrates it and drops it afterwards. Without
that variable, database tests are **skipped with a visible reason**, not
silently passed. See [backend-development.md](backend-development.md#tests).

### Prepared source manifests (2026-11-14)

Source ingest adds no SQL migration or mutable wearer state. Each immutable
upload can have a versioned JSON preparation object next to its original object
(`<object_key>.prepared-v1.json`), carrying text, page/image refs, normalized PNGs
and warnings. Both use the upload's existing owner-scoped object-key prefix.
The normal `stored` → `ready` / `failed` status transition records preparation
success or failure. Generation saves resolved image bytes and provenance in the
revision definition; published packages use that immutable definition. Future
upload/object garbage collection must remove the preparation sidecar as well as
the original source. See [model-pipeline.md](model-pipeline.md).

### External assistant operation receipts (2026-11-14)

Migration `0002_assistant_drafts.sql` adds `assistant_draft_operations`, keyed by
`(owner_id, operation_id)`. It stores the canonical request fingerprint and the
public draft response (no definition, credentials or wearer state). A
transaction-scoped advisory lock on owner/key serializes concurrent retries before
project creation. Receipt, project/revision and change-review inserts commit
atomically; failures roll back together. Receipts have no automatic expiry, so
retrying an old operation cannot unexpectedly create a new draft. Owner deletion
cascades receipts. Revision creation still uses the existing project lock and
numbering functions. Keys are independent from the durable job key namespace.

### Voice note migrations (2026-11-14)

`0003_voice_notes.sql` creates the notes table and allows the transcription job
kind. This file was accidentally excluded from the initial feature push by a
local Git exclusion; it is now tracked. `0004_note_recorder_sessions.sql` adds
bounded native recorder sessions. Only HMACs are stored, not bearer tokens.
Expired rows are removed for the owner when issuing another session; DELETE
revokes the current recorder token, or all of the owner's recorder tokens when
called with a full user session. Every lookup includes expiry and every
revocation filters by owner. User deletion cascades both tables.
`0005_coach_requests.sql` allows the `coach_request` job kind (task coach); no new
tables: requests are jobs, and coach progress is part of the backed-up state snapshot.
`0006_care_labels.sql` allows `extract_care_label` (laundry). Garments live in revision
definitions (`task.data`); laundry progress lives in the backed-up state snapshot (`task.laundry`).
