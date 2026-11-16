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
| `prepare_upload` | `POST /v1/uploads` | 3 | Implemented (source preparation) |
| `package_release` | `POST /v1/projects/:id/releases` | 5 | Implemented |
| `generate_revision` | `POST /v1/projects/:id/messages` | 2 | Implemented (`apps/worker/src/generate.ts`) |
| `transcribe_voice_note` | `PUT /v1/notes/:id/audio`, `POST /v1/notes/:id/transcribe` | 4 | Implemented (`apps/worker/src/transcribe.ts`) |
| `coach_request` | `POST /v1/coach/requests` | 2 | Implemented (`apps/worker/src/coach.ts`) |
| `extract_care_label` | `POST /v1/laundry/labels` | 2 | Implemented (`apps/worker/src/laundry.ts`) |

### `prepare_upload`

Verifies stored size, prepares source text and normalized image/page manifests,
then marks the upload `ready`. A permanent failure marks it `failed`. Source
preparation is repeatable and preserves the original upload. See
[the source-preparation contract below](#source-preparation-and-generation-checks-2026-11-14)
and [pipeline limits](model-pipeline.md).

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

### `extract_care_label`

Laundry label reading ([laundry.md](laundry.md)). Input `{ uploadId, region: iso|us }`;
idempotency key `label:<uploadId>:<region>`.

1. Load the upload; it must belong to the job's owner and be an image.
2. Prepare the image (bounded, normalized) and a 96×96 WebP thumbnail.
3. Call `LABEL_MODEL` (default free `fake:labels`, which recognizes fixture file
   names) with the `care_label` JSON schema.
4. Normalize: invalid values become `unreadable`, nothing is confirmed. Result
   `{ uploadId, region, extraction: { label, fibers, needsClearerImage, note }, thumbnail }`.

No side effects besides the job result, so a repeat is harmless. The original photo
stays in storage as the source of every instruction.

### `coach_request`

Task coach question or problem report from the glasses ([task-coach.md](task-coach.md)).
Input `{ projectId, revisionId, stepId, kind: question|problem, text, clarifications[] }`;
idempotency key `coach:<deviceId>:<operationId>`. The revision is pinned at enqueue.

1. Load and validate the revision; it must have a `guide` and the step must exist
   (`not_a_guide`, `unknown_step`, not retryable).
2. Problem reports about damage, injury, electrics or stability return
   `unsupported` ("stop and contact the retailer") **without a model call**.
3. Retrieve passages (step text and verbatim excerpts, current step always
   included; for problems also the two steps before it) and call `COACH_MODEL`
   (default free `fake:coach`) with a JSON schema.
4. Check the output against the given passages (`checkAnswer` /
   `checkRecovery` in `applet-runtime`): missing or invented citations, a return
   step after the current one, or oversized copy fail closed to "the manual
   doesn't say". Result `{ kind, answer }` or `{ kind, recovery }`; usage recorded.

No side effects besides the job result, so a repeat is harmless. Model errors
map to `model_<code>` like generation.

### `transcribe_voice_note`

Input `{ noteId, sha256, force? }`; idempotency key `note:<id>:<sha256>`.
1. Load the note. Deleted, or its audio hash isn't `sha256` any more (a newer
   upload): finish as a no-op. Already transcribed for this hash and not
   `force`: no-op.
2. Mark it `transcribing`, read the audio from storage, and call
   `NOTES_TRANSCRIBE_MODEL`. Default: OpenRouter's `/api/v1/audio/transcriptions`
   (`openrouter-stt:mistralai/voxtral-mini-transcribe-3-0`, `language=en`, `context_bias` = up to 100
   words from the applet, passed in Mistral provider options as spelling hints), through
   `packages/model/src/transcription.ts`. A chat-model spec instead gets the
   audio as a message part with a verbatim-transcript prompt.
   `cleanTranscript` strips a trailing "stop recording meta" either way.
3. Save the transcript only if the audio hash still matches, and never over a
   transcript the wearer edited. A permanent failure marks the note `failed`
   (the audio stays; the phone offers "Transcribe again"). Transcripts are
   never logged; usage and cost are recorded on the job.

`fake:notes` is free: it returns the text a test clip carries after
`TRANSCRIPT:` in its bytes, or a description of the clip.

### `generate_revision`

Input: `{ projectId, messageId, baseRevisionId, attachmentIds, model }`.

1. If this job already saved its assistant reply, return it (repeat run, no model call).
2. Base = `baseRevisionId`, else the project's latest valid revision.
3. Resolve `model` (must be in `AUTHORING_MODELS`/`AUTHORING_MODEL`) through
   the model registry (`packages/model`). Progress stages: `preparing`,
   `generating`, `repairing`.
4. Prepare owner-filtered conversation attachments and explicit URLs, and give
   the model extracted text, supported images and bounded source tools. Text-only
   models cannot inspect diagrams; limits are in [model-pipeline.md](model-pipeline.md).
5. Parse `{ reply, definition|null }`; validate the canonical schema, references,
   copy and source refs, hydrate images, and measure fit at 600×600. A `task`
   the model adds (or whose kind differs from the current revision's) is an
   issue: task modules come from server code, never from the model. Up to two
   repairs retain tool context and receive exact issues. A clarification can
   succeed without producing a revision.
6. In one transaction: revision (`source: model`, `job_id`), assistant message,
   and the project title if it was still the placeholder "New solution" (or the
   older "New applet"). Result
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

The reserved top-level `assets` object stays empty. Offline image bytes and
provenance live in `definition.assets[].data`; packaging does no live fetch.
Shared fonts, icons and components ship with the app. Source/definition/motion
limits exist; a global package-size budget remains open.

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


### Multiple model providers

Generation and voice resolution share the server-configured model registry.
`anthropic:` uses native Messages, `gemini:` uses native generateContent, and
operator-defined prefixes use independent Chat Completions endpoints. Missing
credentials fail as `model_not_configured` before generation/fit work. Models
configured without tools skip source-tool rounds; prepared source text is still
provided. Search is enabled by the adapter's `webSearch` capability (currently
OpenRouter only), rather than by checking a provider name.

The response schema always reaches the adapter. Native Anthropic/Gemini and
compatible `prompt` mode include it as prompt guidance, avoiding rejection of
our complex schema by providers with restricted JSON Schema support. Existing
local definition validation, repairs and rendered-fit checks remain required.
Gemini's complete signed model parts are retained across tool rounds; function
results are paired with their calls. Direct providers report token usage, including
Gemini thinking tokens and Anthropic cache input, with `costUsd: null` when no
actual cost is returned. No price estimates are invented. Offline contract tests
cover wire formats and errors; direct paid-provider behavior is unverified.
