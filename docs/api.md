# HTTP API reference

Status: **implemented** in `apps/api` (2026-11-14) and covered by integration
tests against PostgreSQL. Not yet deployed. The design rationale lives in
[backend-architecture.md](backend-architecture.md); this page is the contract.

All paths are on one origin (the Aiven Runtime URL in deployment,
`http://127.0.0.1:8080` locally). JSON in, JSON out, UTF-8. Timestamps are ISO
8601 strings. IDs are UUIDs; a malformed ID returns 404, never 400.

## Authentication

Send `Authorization: Bearer <token>` on every `/v1` request except
`POST /v1/devices/pair`.

| Session | Token | Issued by | Can do |
| --- | --- | --- | --- |
| User (authoring) | Clerk session JWT (`AUTH_MODE=clerk`); `dev:<name>` only in dev mode | Clerk; local placeholder in dev | everything except writing state backups |
| Device (glasses) | `j26d_<43 chars>` | `POST /v1/devices/pair` | read the library, sync releases, download packages, back up and restore state, update `lastOpenedAt` |

**Clerk web accounts:** `AUTH_MODE=clerk` verifies the JWT signature, expiration,
activation time, exact configured issuer and allowed frontend origin (`azp`).
Tokens must identify a user and a session, with no pending account tasks. OAuth
access tokens and machine credentials are rejected; delegated connector access
is not implemented. Use `getToken()` from the frontend SDK for each request.
Missing/invalid credentials return the same `401 unauthenticated` response.
Ownership uses the verified issuer and subject, never an email or display name.
Setup and verification limits: [authentication-plan.md](authentication-plan.md).

`AUTH_MODE=dev` still trusts `dev:<name>` (`[A-Za-z0-9_-]{1,64}`) locally.
The config loader **refuses dev mode when `NODE_ENV=production`**. Switching to
Clerk creates a separate identity; local dev libraries are not automatically
merged into a real account.

**Device sessions are real.** Tokens are 32 random bytes, shown once, and stored
only as `HMAC-SHA256(SESSION_SECRET, token)`. Revoking a device invalidates its
token immediately. Rotating `SESSION_SECRET` invalidates every device and
pairing code.

Ownership is enforced on every query. Another user's project, job, upload,
release or device is reported as `404 not_found`, the same as one that doesn't
exist.

## Conventions

**Errors** always have this shape:

```json
{ "error": { "code": "release_precondition_failed", "message": "…", "details": { } } }
```

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Body/headers invalid. `details` lists `{ path, message }` per issue |
| 400 | `invalid_pairing_code` | Wrong, expired or already used pairing code |
| 401 | `unauthenticated` | Missing, invalid or revoked token |
| 403 | `forbidden` | Valid session of the wrong kind (device on an authoring endpoint, or the reverse) |
| 404 | `not_found` / `no_release` / `no_state` | Missing or not yours / never published / never backed up |
| 409 | `idempotency_key_reused` | Same `Idempotency-Key`, different request body |
| 409 | `release_precondition_failed` | `expectedCurrentReleaseId` is stale. `details.currentReleaseId` |
| 409 | `review_required` | The revision has unaccepted data-loss findings |
| 409 | `state_conflict` / `state_stale` | See [state backup](#state-backup) |
| 413 | `payload_too_large` | Body over the limit |
| 415 | `unsupported_media_type` / `content_mismatch` / `empty_upload` | Upload type not allowed, bytes don't match the type, or no bytes |
| 422 | `invalid_definition` / `revision_invalid` | Definition check failed; `details.issues` |
| 500 | `internal` / `package_missing` | Server fault (logged with the request ID) |
| 502 | `storage_unavailable` | Object storage failed; retry |

**Request IDs.** Every response has `X-Request-Id`. Send your own (`[\w.-]{1,64}`)
to correlate client and server logs.

**Idempotency.** Endpoints that create jobs accept `Idempotency-Key` (8–128
printable ASCII characters; a UUID is ideal). Retrying with the same key returns
the original result with status `200` instead of `202`. Reusing a key with a
different body returns `409 idempotency_key_reused`. Keys are scoped per user
and kept forever (they live on the job row).

**Limits** (env-configurable): JSON bodies ≤ max(`MAX_DEFINITION_BYTES`,
`MAX_STATE_BYTES`) + 64 KiB; uploads ≤ `MAX_UPLOAD_BYTES` (50 MiB default).

## Endpoints

| Method and path | Session | Success | Notes |
| --- | --- | --- | --- |
| `GET /healthz` | none | 200 | Process is up |
| `GET /readyz` | none | 200 / 503 | `{ ok, checks: { database, storage } }`, 3 s timeout each |
| `GET /v1/me` | any | 200 | `{ principal: { kind, userId, deviceId? } }` |
| `GET /v1/projects` | any | 200 | Library, most recently opened first, with `currentRelease` summary |
| `POST /v1/projects` | user | 201 | `{ title }` (1–80 chars) |
| `GET /v1/projects/:id` | any | 200 | |
| `PATCH /v1/projects/:id` | any¹ | 200 | `{ title?, lastOpenedAt? }`; `lastOpenedAt` only moves forward |
| `GET /v1/projects/:id/messages` | user | 200 | Authoring thread, oldest first |
| `POST /v1/projects/:id/messages` | user | 202 | `{ text, attachmentIds?, baseRevisionId?, model? }`; queues `generate_revision`. `model` must be one of `GET /v1/authoring/models` (400 otherwise). Idempotency-Key optional |
| `GET /v1/projects/:id/revisions` | user | 200 | Summaries (no definition), newest first |
| `POST /v1/projects/:id/revisions` | user | 201 | `{ definition, baseRevisionId? }`; see [revisions](#revisions) |
| `GET /v1/projects/:id/revisions/:revisionId` | user | 200 | Includes `definition` |
| `GET /v1/projects/:id/releases` | user | 200 | All releases including pending/superseded/failed |
| `POST /v1/projects/:id/releases` | user | 202 | Publish; see [publishing](#publishing). **Idempotency-Key required** |
| `GET /v1/projects/:id/releases/latest` | any | 200 / 304 | Sync manifest; `ETag` = release ID |
| `GET /v1/releases/:id/package` | any | 200 / 304 | Streams the package; `ETag` = SHA-256 |
| `GET /v1/projects/:id/state` | any | 200 | Last accepted backup |
| `PUT /v1/projects/:id/state` | device | 200 | Backup; see [state backup](#state-backup) |
| `POST /v1/uploads?projectId=&filename=` | user | 201 | Raw body upload; see [uploads](#uploads) |
| `GET /v1/uploads/:id` | user | 200 | Upload status |
| `GET /v1/jobs/:id` | user | 200 | Status, progress, result, error, usage |
| `POST /v1/jobs/:id/cancel` | user | 202 | Best effort; see [jobs.md](jobs.md#cancellation) |
| `POST /v1/devices/pairing-codes` | user | 201 | `{ code, expiresAt, pairUrl }` |
| `POST /v1/devices/pair` | **none** | 201 | `{ code, label? }` → `{ token, device }` |
| `GET /v1/devices` | user | 200 | Paired devices, including revoked |
| `DELETE /v1/devices/:id` | user | 200 | Revokes; idempotent |
| `PUT /v1/voice/context` | device | 200 | Open applet's tools and values for the voice bridge; see [voice bridge](#voice-bridge) |
| `DELETE /v1/voice/context` | device | 200 | Applet closed |
| `GET /v1/voice/events` | device | 200 | Server-sent `command` events |
| `POST /v1/voice/utterances` | user, device | 200 | One utterance (`audio/wav`, `audio/mpeg` or JSON `{ text }`) → outcome |
| `GET /v1/notes/recorder/events` | user | 200 | Phone recorder: server-sent `start` / `stop`; see [voice notes](#voice-notes) |
| `POST /v1/laundry/labels` | user | 202 / 200 | `{ uploadId, region? }` → `extract_care_label` job (one per photo); poll `GET /v1/jobs/:id`. See [laundry.md](laundry.md) |
| `POST /v1/coach/requests` | device | 202 / 200 | Task coach question/problem → `coach_request` job; idempotent per operation; see [task coach](#task-coach) |
| `GET /v1/coach/requests/:id` | device | 200 | `{ request: { id, status, result, error } }` |
| `POST /v1/coach/requests/:id/cancel` | device | 202 | Best-effort cancel |
| `POST /v1/notes` | device | 201 / 200 | Start a note on the open page; `409 no_recorder` when no phone recorder is on |
| `GET /v1/notes?projectId=` | user | 200 | Notes of an applet, newest first |
| `GET /v1/notes/counts?projectId=` | user, device | 200 | Saved notes per page |
| `GET /v1/notes/:id` | user, device | 200 | One note |
| `GET /v1/notes/:id/events` | user, device | 200 | Server-sent status of one note until `saved` / `discarded` |
| `POST /v1/notes/:id/stop` | user, device | 200 | `{ reason: band \| voice \| timeout }` → asks the recorder to stop |
| `POST /v1/notes/:id/recording` | user | 200 | Recorder confirms it is recording |
| `POST /v1/notes/:id/discard` | user, device | 200 | `{ reason }`; nothing worth keeping (only notes without audio) |
| `PUT /v1/notes/:id/audio?durationMs=&endReason=` | user | 201 / 200 | Raw `audio/wav` or `audio/mpeg`; queues `transcribe_voice_note` |
| `GET /v1/notes/:id/audio` | user | 200 | Streams the recording |
| `POST /v1/notes/:id/live` | user | 200 | One short `audio/wav` window → `{ stop, startSeconds }` (cloud stop-phrase check) |
| `PATCH /v1/notes/:id` | user | 200 | `{ transcript }`; marks it edited (later transcriptions keep the edit) |
| `POST /v1/notes/:id/transcribe` | user | 202 | Transcribe again |
| `DELETE /v1/notes/:id` | user | 200 | Deletes the note and its recording |
| `GET /v1/authoring/models` | any | 200 | `{ default, models: [{ id, label, provider, free, default }] }` for the model picker |
| `GET /v1/authoring/capabilities` | any | 200 | The capability catalog (`capabilities`, `limitations`) the authoring model is given |
| `GET /glasses/*`, `GET /author/*` | none | 200 | Built web apps when `WEB_ROOT` is set; unknown paths fall back to `index.html`; `assets/` immutable, HTML `no-cache` |

¹ A device may only send `lastOpenedAt`; changing `title` needs a user session.

Not implemented yet (from the architecture's proposed surface):
`POST /v1/projects/:id/reviews` (change review acceptance). The diff exists in
`packages/applet-format` and the authoring app shows it, but acceptance isn't
recorded server-side yet.

**CORS.** `/v1/*` answers CORS for `CORS_ORIGINS` (the Capacitor shells and dev
servers). Bearer tokens, no cookies, so credentials mode stays off. The
glasses app and the web authoring app are same-origin and don't need it.

### Revisions

A revision is a complete, immutable candidate definition. Revisions are numbered
1, 2, 3… per project. `POST …/revisions` is the path for definitions that don't
come from our generation worker: a bring-your-own assistant (milestone M7),
scripted authoring, and tests.

The definition is checked by the **interim** structural check in
`packages/server-common/src/definition.ts`: an object with an integer
`formatVersion` in `{1, 2}`, a non-empty `title` ≤ 32 characters, an optional
semver `minimumRuntimeVersion`, and size ≤ `MAX_DEFINITION_BYTES`. Invalid
definitions return `422 invalid_definition` with every issue and are not stored.
The full applet validation pipeline arrives with `packages/applet-format`
(milestone M1) and replaces this check.

### Publishing

```http
POST /v1/projects/:id/releases
Idempotency-Key: 0b7e…
{ "revisionId": "…", "expectedCurrentReleaseId": null }
```

1. Checks, under the project row lock: `expectedCurrentReleaseId` equals the
   project's current release (`null` for a first publish), the revision belongs
   to the project and is valid, and no change review for it is unaccepted.
2. Creates a `pending` release and a `package_release` job, and returns
   `202 { release, job }`. Nothing is live yet: `packageUrl` is `null`.
3. The worker builds and uploads the package, then advances the project's
   pointer **only if it still equals the expected base**. Otherwise the release
   becomes `superseded` and the pointer doesn't move. Poll the job; its
   `result.status` is `ready` or `superseded`.

Two publishes against the same base can both be accepted in step 2; exactly one
becomes `ready`. Details: [jobs.md](jobs.md#package_release).

### Sync and package download (glasses)

The glasses never poll. On an explicit sync they:

1. `GET /v1/projects` for the library (`currentRelease.id` per project), or
   `GET /v1/projects/:id/releases/latest` with `If-None-Match: "<releaseId>"`
   (304 when unchanged; `Cache-Control: private, no-cache`).
2. If the release changed, `GET release.packageUrl`. The response has
   `ETag: "<sha256>"`, `X-Content-SHA256`, `Content-Length` and
   `Cache-Control: private, max-age=31536000, immutable`. Verify the hash, store
   the package by release ID, then activate it atomically.

Packages are streamed from object storage by the API. Verda has no CORS, so a
browser can't fetch from it directly, even with a presigned URL.

### Uploads

```http
POST /v1/uploads?projectId=<optional>&filename=manual.pdf
Content-Type: application/pdf
<raw file bytes>
```

The body is the file itself (not multipart), so the API can stream it to
storage without buffering. Accepted types: `application/pdf`, `image/png`,
`image/jpeg`, `image/webp`, `text/plain`, `text/markdown`. While streaming, the
API enforces `MAX_UPLOAD_BYTES` (also without `Content-Length`), checks the
leading bytes against the declared type, and computes the SHA-256. A rejected
upload leaves no object behind and is recorded with status `rejected`.

Returns `201 { upload, job }`. The upload is `stored`; the `prepare_upload` job
marks it `ready` (or `failed`). Pass ready upload IDs as `attachmentIds` on a
message.

### Device pairing

1. Signed in on the phone: `POST /v1/devices/pairing-codes` →
   `{ code: "K7QX-M2PA", expiresAt, pairUrl }`. Codes are 8 characters from an
   unambiguous alphabet (~40 bits), valid for 10 minutes, usable once, stored
   only as an HMAC. `pairUrl` (`<PUBLIC_ORIGIN>/glasses/#pair=<code>`) is meant
   for a QR code.
2. On the glasses: `POST /v1/devices/pair { code, label? }` →
   `{ token, device }`. Case, spaces and dashes in the code are ignored. Store
   the token on the device; it can't be shown again.

There's no attempt limit on pairing yet. With 10-minute codes the guessing odds
are tiny, but add per-IP rate limiting before a public launch.

### Voice bridge

Fallback for "Hey Meta" (plan: [voice-fallback.md](voice-fallback.md)). An
always-listening phone bridge posts speech; the API resolves it against the
applet open on the same owner's glasses and pushes the action there.

1. Glasses (voice switched on, applet open): `PUT /v1/voice/context`
   `{ projectId, title, view, tools, state }`. `tools` are the WebMCP tool
   declarations (`name`, `description`, `parameters`; ≤64), `state` is the
   `describeState` text (≤8000 chars). Re-sent only when it changes; it expires
   after 10 minutes. Then `GET /v1/voice/events` (SSE): `ready`, then
   `command` events `{ id, tool, args, heard }`, with a keepalive comment every
   25 s. The glasses close the stream when hidden.
2. Bridge: `POST /v1/voice/utterances` with up to 512 KB of `audio/wav` /
   `audio/mpeg`, or `{ text, id? }` (≤500 chars). Send `X-Utterance-Id`
   (8–64 of `[A-Za-z0-9_-]`) to make retries safe: a repeated id returns the
   first answer for 2 minutes and never acts twice.
3. Answer `200 { id, outcome, … }`, sent after delivery:
   - `command`: delivered. Includes `tool`, `args` and `heard`.
   - `ignored`: the model chose not to act. `reason` is `not_for_applet`,
     `unknown_tool`, `bad_arguments` or `no_tool_call`.
   - `no_glasses`: no glasses are listening with an open applet. This is
     checked before any model call.
   - `undelivered`: the glasses closed or switched applet while the model ran.

   Errors: `415 unsupported_media_type`, `413 payload_too_large`,
   `422 voice_unsupported_input` (audio sent to a text-only `VOICE_MODEL`),
   `503 voice_model_unavailable` (model failed or took over 10 s).

The model (`VOICE_MODEL`, default `google/gemini-3.5-flash-lite`; `fake:voice`
is a free keyword matcher) must call exactly one applet tool or `ignore`. Only
tools in the current context are deliverable. The glasses look the tool up
again and the runtime validates its arguments. Audio and transcripts are never
logged or stored. Logs carry the id, outcome, tool name, model, cost and
timing. Fan-out is in-process, so the API must run as a single instance until
it moves to `LISTEN/NOTIFY`.

### Voice notes

Spec: [voice-notes.md](voice-notes.md). The glasses start a note, the phone
recorder (a user session) records and uploads it, the worker transcribes it.

1. Phone: `GET /v1/notes/recorder/events` (SSE) while the recorder is on.
   Events: `ready`; `start { note: { id, projectId, viewId, stepId, pageLabel,
   noteLabel, maxSeconds } }`, sent to the most recently connected recorder
   only; `stop { noteId, reason }`, sent to all of the user's recorders.
2. Glasses: `POST /v1/notes` `{ id (client UUID), projectId, releaseId?,
   viewId, stepId?, pageLabel (≤120), noteLabel?, stateSnapshot? }`. Retrying
   the same `id` returns `200` with the existing note and sends `start` again
   only while it is still `starting`. Without an open recorder: `409
   no_recorder` and nothing is stored. Then `GET /v1/notes/:id/events` (SSE):
   `ready`, `status { status }`, `recording { startedAt }`, `stopping
   { reason }`, then `saved` or `discarded { reason }`, which end the stream.
3. Phone: `POST /v1/notes/:id/recording` as soon as it records. Optional live
   check: `POST /v1/notes/:id/live` with ≤384 KB of WAV (the last few seconds)
   answers `{ stop, startSeconds }` from `NOTES_LIVE_MODEL`; nothing is stored.
   Errors `422 live_unsupported`, `503 live_model_unavailable`.
4. Phone: `PUT /v1/notes/:id/audio?durationMs=&endReason=` with the trimmed
   recording (`audio/wav` or `audio/mpeg`, sniffed, at most
   `NOTES_MAX_SECONDS` × 40 KB). `endReason` ∈ phrase, band, voice, timeout,
   disconnect, interrupted, phone. Identical bytes again: `200`, same job.
   Answers `{ note, jobId }`.

While a note of a user is recording, `POST /v1/voice/utterances` answers
`200 { outcome: "paused", reason: "note_recording" }` so dictation never runs
applet actions (cleared on upload/discard, or after the time limit + 1 min).

Note JSON: `id, projectId, releaseId, viewId, stepId, pageLabel, noteLabel,
stateSnapshot, status (starting | recording | uploaded | transcribing |
transcribed | failed | discarded), endReason, startedAt, endedAt, durationMs,
audio ({ url, mediaType, bytes } or null), transcript, transcriptEdited,
transcriptModel, language, error`. Object keys never leave the server.
Audio is stored by design (owner decision); it and transcripts are never
logged. Fan-out is in-process like the voice bridge (single API instance).

### Task coach

Questions and problem reports from a guide made from a manual
([task-coach.md](task-coach.md)). Device sessions only; owner-scoped.

```http
POST /v1/coach/requests            (device session)
{ "operationId": "…", "projectId": "…", "kind": "question" | "problem",
  "stepId": "cam_locks", "text": "…", "clarifications": ["…"] }
```

- `operationId`: 8–128 of `[A-Za-z0-9_-]`, chosen by the glasses. Resending it
  returns the same request (`200`, `replayed: true`) instead of a new job.
- The project must be published (`409 not_published`) and its current release's
  revision must have a `guide` (`409 not_a_guide`); `stepId` must be in it
  (`422 unknown_step`). Text ≤ 500, up to 3 clarifications ≤ 200 each.
- Responses expose only `{ id, status, result, error: { code, retryable } }`:
  no usage, attempts or internal details. `result` is
  `{ kind: "question", answer: { status: answered|insufficient|clarify, text, sources[], options[] } }`
  or `{ kind: "problem", recovery: { status: proposal|clarify|unsupported, … } }`.

### State backup

The glasses are the only writer of live state. They back up in batches (session
end, explicit sync), never per action.

```http
PUT /v1/projects/:id/state            (device session)
{ "operationId": "…", "sequence": 42, "revisionId": "…", "schemaVersion": 1,
  "expectedServerVersion": 3, "snapshot": { … } }
```

- `operationId`: unique per backup attempt. Resending it returns the original
  outcome with `replayed: true` and changes nothing.
- `sequence`: the device's monotonic counter.
- `expectedServerVersion`: the `serverVersion` this device last got back (0 if
  never).

| Outcome | Response |
| --- | --- |
| Accepted | `200 { outcome: "accepted", serverVersion, replayed }`; remember `serverVersion` |
| Another device or an older copy wrote in between | `409 state_conflict`, `details.current = { serverVersion, deviceId, sequence }` |
| Same device, sequence not newer than the stored one | `409 state_stale` |

Refused snapshots are **kept** in `state_backups`, never merged or discarded,
so a recovery UI can offer them later. `GET …/state` returns the last accepted
snapshot with its `serverVersion`, `deviceId`, `sequence`, `revisionId`,
`schemaVersion` and `savedAt`.

### Authoring source import (2026-11-14)

Upload support now includes `text/csv`, `application/json`, `text/html`, and
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` in
addition to PDF, PNG, JPEG, WebP, GIF, plain text and Markdown. GIF uploads use
`Content-Type: image/gif` with a checked GIF87a/GIF89a signature. Preparation
preserves bounded looping motion and supplies a separate first-frame PNG for
model context; oversized motion fails with `source_motion_limit`. See
[video-tutorials.md](video-tutorials.md). No YouTube import endpoint is exposed.
The API upload ceiling
still defaults to 50 MiB; current authoring preparation accepts at most 12 MiB
per source and asks for an excerpt when a source exceeds its processing budget.
JSON and Word content receive deeper validity checks in preparation. See
[model-pipeline.md](model-pipeline.md) for page, text, archive and image limits.

Existing message endpoints now support public source URLs in message text and
model-driven bounded source tools. No new browser-to-provider endpoint exists;
all model access remains behind `packages/model` in the worker. Generation may
return a clarification with no revision when a link cannot be read. Follow-ups
reuse conversation uploads and preserve base images without requiring another
upload. Model revisions are accepted only after source-ref resolution and
canonical 600×600 rendering checks. This does not strengthen validation on direct
client revision submissions or add server-side change acceptance.

Generated `assets` retain `uploadId` (the prepared image ref), normalized PNG
`data` (or preserved GIF data for motion), `source` (file/page or URL), and optional `attribution`. The renderer
consumes image data offline. These source refs are checked against owner-filtered
attachments, tool imports and base assets before the worker saves a revision.

## External assistant drafts (private local proof)

The shared MCP adapter uses these authoring-user-only endpoints. Device sessions
are refused. See [assistant-mcp.md](assistant-mcp.md) for transports and setup.
These are separate from the interim direct revision submission contract above;
external assistant drafts always use the full `packages/applet-format` validator.

- `GET /v1/assistant/capabilities`: current schema, catalog, versions, copy limits,
  authoring policy and text-only restrictions. `contractVersion: 1`.
- `POST /v1/assistant/validate` with `{ definition }`: returns `{ valid, issues,
  measuredFit: "not_checked", sourceFidelity: "not_checked" }`. No persistence.
- `POST /v1/assistant/drafts`, required `Idempotency-Key`:
  - create body: `{ mode: "create", title, definition }`;
  - revise body: `{ mode: "revise", projectId, baseRevisionId, definition }`.

A create atomically saves a project and immutable revision. Revise requires the
latest exact base, computes change findings against both that base and the current
published revision, and saves a pending `change_reviews` row. It never changes
wearer state or queues managed generation. Text-only: nonempty assets are rejected.
Structural validation is not a rendered-fit check. Publication remains a separate
operation, with the existing review block enforced.

First success returns 201; replay returns 200 with the original result (project,
revision summary, findings, project `previewUrl`, `reviewRequired`,
`measuredFit: "not_checked"`, `published: false`). The preview URL opens the project;
select the returned revision in its Preview tab. No credentials are embedded.
Retries with the same owner/key and canonical JSON content return the same IDs,
including after restart. Different content under that key returns 409
`idempotency_key_reused`. Failed requests roll back and do not reserve the key.
Keys are scoped to this endpoint, separately from job idempotency keys.

Other errors: 422 `invalid_definition` with full validator issues (including
`external_assets_unsupported`); 404 for foreign/missing projects or revisions;
409 `stale_revision` with `latestRevisionId`; 409 `unsupported_base_revision` if a
base/published definition cannot be safely interpreted by the current validator.
Malformed bodies/missing or invalid idempotency keys return 400. Pending findings
cannot currently be accepted through an MCP tool or the existing client checkbox.

## Clerk MCP OAuth transport

Optional `MCP_RESOURCE_URL` enables `POST /mcp` and public protected-resource
metadata at `/.well-known/oauth-protected-resource/mcp` (also the root metadata
alias). Requires `AUTH_MODE=clerk`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and
normal issuer settings. The resource must be the exact canonical HTTPS `/mcp`
URL without query or trailing slash; local non-production loopback HTTP is allowed.
Keep the same value in Clerk's resource registration and MCP clients.

Only Clerk OAuth access tokens are accepted, with signature, issuer, expiry and
resource audience checks. Cookies, first-party sessions, device credentials and
dev tokens fail. OAuth tokens also fail on all ordinary `/v1` routes. Each MCP
request resolves a distinct delegated principal and uses a scope-checked,
in-process allowlist to call existing authoring operations, without forwarding
the token or promoting it to a full web session.

`applets:read` authorizes capabilities/library/revision reads and validation;
`applets:draft` additionally authorizes draft saves. Initialization requires read.
No scope grants publication, managed generation, upload ingestion, pairing/device
administration or wearer-state access. A read-only client receives an
`insufficient_scope` tool error with `mcp/www_authenticate` metadata on writes.

401 responses include `WWW-Authenticate: Bearer resource_metadata="<metadata URL>"`;
missing initial read scope returns 403 with `error="insufficient_scope"` and the
required scope. Only POST/OPTIONS are supported (other methods: 405); no server
sessions or persistent event streams are created. Host and optional browser
Origin are checked against configuration. Proxy the canonical Host unchanged.
Responses are not cached; JSON body limits apply. Local signed-token tests and a
real Clerk consent/draft flow have passed; public Claude/ChatGPT clients remain
unverified. Setup and revocation limits: [assistant-mcp.md](assistant-mcp.md).

### Native background recorder sessions

- `POST /v1/notes/recorder/session` (full user session) returns
  `{ token, ownerId, expiresAt }` with HTTP 201. The random `j26r_` token expires
  after 12 hours. It is kept in native memory, never frontend storage or logs;
  the database stores only its keyed HMAC.
- `DELETE /v1/notes/recorder/session` revokes that token when called with a
  recorder credential; a full user session revokes all recorder credentials
  for that owner. Returns `{ ok: true }`. Turning the recorder off/signing out
  invokes revocation. Offline revocation may fail; expiry remains enforced.
- Recorder credentials can only GET `/v1/notes/recorder/events`, POST
  `/:id/recording`, `/:id/discard`, `/:id/live`, PUT `/:id/audio`, or revoke
  themselves. They cannot list/play/edit/delete notes, author, pair glasses,
  or issue more sessions. Note ownership checks still apply. Expired/revoked
  event streams close on the next event or heartbeat (at most 25 seconds).
- Successful audio upload responses include `note.audio.sha256`; all recorders
  compare it against the local WAV before deleting their queued copy.


### Authoring model metadata and provider configuration

`GET /v1/authoring/models` retains `default` and `models[]` (`id`, `label`,
`provider`, `free`, `default`). Each option also includes `available`,
`unavailableReason` (null when available), and `capabilities` when the adapter is
registered: `images`, `files`, `audio`, `structuredOutput`, `tools`, `webSearch`.
`available` means the provider is registered and credentials are present, or
explicitly configured with no authentication. It does not probe the provider,
verify credits, or make a billable request. Credentials and endpoint URLs are
never returned. Unknown explicit provider prefixes remain unknown rather than
being sent to OpenRouter. The model allowlist remains enforced on message sends.

The authoring client groups providers, disables unavailable choices, falls back
to an available choice, shows image-input limits, and blocks sends while metadata
is loading or unavailable. Setup: [model-providers.md](model-providers.md).


### Revision and backup validation

Direct `POST /v1/projects/:id/revisions` submissions use the canonical
`validateDefinition` schema, references and copy constraints, plus
`MAX_DEFINITION_BYTES`. Invalid candidates return `422 invalid_definition`
with issues and are not stored. This does not perform rendered fit validation
or implement managed-generation change review.

State PUT bodies are limited to `MAX_STATE_BYTES` (256 KiB by default), measured
as actual UTF-8 bytes even when `Content-Length` is absent. Oversized requests
return `413 payload_too_large`.
