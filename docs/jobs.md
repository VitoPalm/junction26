# Background jobs

Status: **implemented** in `apps/worker` and `packages/db/src/queries/jobs.ts`
(2026-11-14), tested against PostgreSQL. Design intent:
[backend-architecture.md](backend-architecture.md#generation-and-job-execution).

The API never does long work inside a request. It writes a row to `jobs` and
returns `202`. Workers claim rows from PostgreSQL. There's no Redis or in-memory
queue, and every bit of progress lives in the database, so restarting any
process loses nothing.

## Lifecycle

```text
            claim (lease)                 complete
 queued ────────────────────► running ─────────────► succeeded
   ▲  ▲                        │  │  │
   │  └─ retryable failure ────┘  │  └─ non-retryable / out of attempts ─► failed
   │     (run_after = backoff)    │
   │                              └─ cancel requested + heartbeat ──────► cancelled
   └─ graceful shutdown (attempt not counted)
 queued ── cancel ──► cancelled
```

- **Claim.** `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`.
  Concurrent workers never get the same job. The claim increments `attempts`
  and sets `lease_owner` + `lease_expires_at` (`WORKER_LEASE_MS`, default 60 s).
- **Heartbeat.** Every lease/3 the runner extends the lease and reads
  `cancel_requested`. `ctx.progress(value)` also saves progress that
  `GET /v1/jobs/:id` shows.
- **Fencing.** Every write after the claim (heartbeat, complete, fail, cancel)
  matches on `lease_owner`. A worker that lost its lease, for example after a
  long GC pause, can't overwrite the new owner's result. Its result is
  discarded and logged.
- **Crash recovery.** A `running` job whose lease expired is claimable again,
  while `attempts < max_attempts`. If the lease expires on the last attempt,
  a periodic sweep marks the job `failed` with `lease_expired`.
- **Retries.** A handler throws `JobError(code, message, { retryable })`.
  Retryable errors are requeued with exponential backoff (2 s, 4 s, 8 s…, max
  60 s). Others fail immediately. Unexpected exceptions count as retryable.
  `max_attempts` is set per kind at enqueue time.
- **Shutdown.** On SIGTERM the worker stops claiming and waits for running jobs
  (up to `SHUTDOWN_GRACE_MS` − 5 s). Then it aborts the rest and puts them back
  in the queue without counting the interrupted attempt, so another worker
  picks them up at once instead of waiting for the lease.

### Cancellation

`POST /v1/jobs/:id/cancel` cancels a queued job immediately. For a running job
it sets `cancel_requested`. At the next heartbeat the runner aborts the
handler's `ctx.signal` and marks the job `cancelled`. Handlers must pass
`signal` to network and storage calls, or check it between steps. Cancellation
is best effort: a model call that already completed may still be billed.

### Exactly-once? No.

A handler can run more than once (crash after side effects, before
`completeJob`). Every handler is written to be safe to repeat: deterministic
object keys, row-level state checks inside transactions, "already done" early
returns. External model calls may repeat after an ambiguous failure, so cap
attempts and tokens rather than assume exactly-once inference.

## Concurrency and budget

- `WORKER_CONCURRENCY` (default 2): jobs in flight per worker process.
- `GENERATION_CONCURRENCY` (default 2): of those, how many may be
  `generate_revision` (model spend). The runner stops claiming that kind when
  it's at the cap and keeps claiming other kinds.
- Scale by running more worker processes; they coordinate only through the
  database.

## Job kinds

| Kind | Enqueued by | `max_attempts` | Status |
| --- | --- | --- | --- |
| `prepare_upload` | `POST /v1/uploads` | 3 | Implemented (verification only) |
| `package_release` | `POST /v1/projects/:id/releases` | 5 | Implemented |
| `generate_revision` | `POST /v1/projects/:id/messages` | 2 | **Placeholder**: fails with `not_implemented` |

### `prepare_upload`

Checks that the stored object exists with the recorded size, then marks the
upload `ready`. If it fails permanently, the upload becomes `failed`. Milestone
M4 adds the real preparation here (render PDF pages, extract text, crop
diagrams), ported from `experiments/openrouter-ikea-v2`.

### `package_release`

1. Load the release. If it isn't `pending`, return its status (a repeat run).
2. Build the package (below) and upload it to
   `releases/<projectId>/<releaseId>/package.json`. The key and the bytes are
   deterministic, so a retry overwrites the object with identical content.
3. In one transaction: lock the release and the project. If the project's
   `current_release_id` still equals the release's `base_release_id`, mark the
   release `ready` (key, SHA-256, size) and advance the pointer. Otherwise mark
   it `superseded`.

An incomplete package can never become live: the pointer moves only after the
upload has succeeded. If the job fails permanently, the release is marked
`failed`. Objects left by superseded or failed releases aren't cleaned up yet
(a later sweep job).

### `generate_revision`

Not built yet (milestone M4: `packages/model` + `packages/ingest`). It fails at
once with a non-retryable `not_implemented` error, so no money is spent and the
client can say why. The input is already final: `{ projectId, messageId,
baseRevisionId, attachmentIds }`. The planned flow: prepare context → call
OpenRouter (`AUTHORING_MODEL`, capped by `MAX_OUTPUT_TOKENS`) → validate → one
bounded repair → save the revision and change review → record `usage`.

## Release package (format 1)

One JSON object per release, immutable once `ready`:

```json
{
  "packageFormat": 1,
  "releaseId": "…", "projectId": "…", "revisionId": "…", "revisionNumber": 3,
  "formatVersion": 1, "minimumRuntimeVersion": "0.1.0",
  "publishedAt": "2026-11-14T08:00:00.000Z",
  "definition": { },
  "assets": { }
}
```

`assets` will map content hashes to applet-specific images once M4 produces
them. Shared fonts, icons and components ship with the glasses app, not with
packages. Size limits and image re-encoding are open decision #4.

## Adding a job kind

1. Add the kind to the `jobs.kind` CHECK constraint in a **new** migration, and
   to `JobKind` in `packages/db/src/rows.ts`.
2. Write a `JobHandler` in `apps/worker/src/handlers.ts` (safe to repeat, honors
   `ctx.signal`, throws `JobError` with a stable code) and register it in
   `defaultHandlers`.
3. Enqueue it from the API with `enqueueJob`, inside the transaction that
   creates the records it works on.
4. Document it in the table above.
