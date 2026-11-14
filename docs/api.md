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
| User (authoring) | `dev:<name>` (dev mode only, see below) | the identity provider (not chosen yet) | everything except writing state backups |
| Device (glasses) | `j26d_<43 chars>` | `POST /v1/devices/pair` | read the library, sync releases, download packages, back up and restore state, update `lastOpenedAt` |

**User auth is a placeholder.** The identity provider is open decision #1 in
[implementation-plan.md](implementation-plan.md#open-decisions-owner-input-needed).
Until then `AUTH_MODE=dev` trusts `dev:<name>` (`<name>` matches
`[A-Za-z0-9_-]{1,64}`) and creates that user on first use. The config loader
**refuses dev mode when `NODE_ENV=production`**, so the backend can't be
deployed with it by accident. Adding a provider means resolving its token to an
external ID in `resolveUser` (`apps/api/src/auth.ts`); nothing else changes.

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
| `POST /v1/projects/:id/messages` | user | 202 | `{ text, attachmentIds?, baseRevisionId? }`; queues `generate_revision`. Idempotency-Key optional |
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

¹ A device may only send `lastOpenedAt`; changing `title` needs a user session.

Not implemented yet (from the architecture's proposed surface):
`POST /v1/projects/:id/reviews` (change review acceptance; needs the diff
package), static serving of `/glasses/` and `/author/` (those apps don't exist
yet).

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
