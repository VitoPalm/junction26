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
| `generate_revision` | `POST /v1/projects/:id/messages` | 2 | Implemented (`apps/worker/src/generate.ts`) |

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

Input: `{ projectId, messageId, baseRevisionId, attachmentIds, model }`.

1. If this job already saved its assistant reply, return it (repeat run, no model call).
2. Base = `baseRevisionId`, else the project's latest valid revision.
3. Resolve `model` (must be in `AUTHORING_MODELS`/`AUTHORING_MODEL`) through
   the model registry (`packages/model`). Progress stages: `preparing`,
   `generating`, `repairing`.
4. Messages: last 12 thread messages, then the current request with the base
   definition and attachments (text inline ≤ 200 KiB; images/PDFs ≤ 12 MiB as
   parts if the model supports them, else skipped and mentioned).
5. Call the model with the JSON schema response format; parse
   `{ reply, definition|null }`; validate with `validateDefinition`. If invalid,
   one repair call with the exact issues.
6. In one transaction: revision (`source: model`, `job_id`), assistant message,
   and the project title if it was still "New applet". Result
   `{ revisionId, revisionNumber, messageId }`; `usage` =
   `{ inputTokens, outputTokens, costUsd, model }`.

Error codes: `model_<code>` from the adapter (`model_not_configured`,
`model_auth`, `model_insufficient_credits`, `model_rate_limited` (retryable),
`model_unavailable` (retryable), `model_timeout` (retryable),
`model_context_too_long`, `model_bad_request`), `model_not_allowed`,
`output_truncated`, `invalid_output` (after the repair), `attachment_too_large`.
`onFailed` posts a plain-language assistant message. Model calls can repeat
after an ambiguous failure; attempts are capped at 2.

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

## Source preparation and generation checks (2026-11-14)

`prepare_upload` now caches extracted source text and normalized image/page PNGs
as JSON at `<upload.objectKey>.prepared-v1.json`, then marks the upload ready.
Its result includes `images` and `warnings`. Unsupported, malformed, encrypted or
oversized sources fail with a source error and mark the upload failed. Source
preparation is repeatable; it does not mutate the uploaded object or user state.
Generation can prepare a `stored` attachment itself if it wins the job race.

`generate_revision` retains source tool context through up to two validation
repairs. It supports eight source tool executions, two bounded web searches and
canonical renderer fit checking before saving a model revision. Fit failures,
unresolvable source refs and unsupported action docking feed exact paths back to
the model. Progress may include `{stage:"repairing", model, repair:1|2}`. A valid
clarification or unsupported-feature response saves a reply with no revision.

Usage includes `searches` and `toolUses` in addition to `inputTokens`,
`outputTokens`, `costUsd`, and `model`. Source-tool web search uses the model
adapter and its reported cost is included. Terminal invalid-output errors include
known usage and up to 20 final issues in `error.details`. Ambiguous provider
failures and cancellations still require cost reconciliation.

Package format remains 1: image bytes live in `definition.assets[].data` with
source/attribution metadata. The legacy reserved top-level `assets` object remains
empty. Publication performs no live image fetch. See
[model-pipeline.md](model-pipeline.md) for processing and network limits and local
Poppler/Chromium prerequisites.

GIF source preparation preserves an infinite loop and a separate PNG first-frame
model preview. It rejects motion exceeding 8 seconds / 96 frames or 512 KiB after
resizing to 360 px with `source_motion_limit`. Managed generation checks a 2 MiB
aggregate GIF budget (`motion_budget` validation issue). Runtime 0.2.0 consumes
the embedded GIF directly. No video import job is registered; the YouTube/FFmpeg
prototype is local-only. See [video-tutorials.md](video-tutorials.md).

GIF steps with essential instruction text are measured together in the canonical
`GifScreen`. GIF decode recovery messages also produce an `image_decode` issue
in generation checks, so a broken animation cannot pass merely because the
component replaces it with fallback text.
