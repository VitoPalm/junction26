# Backend architecture

Status: agreed design, 2026-11-14; provider facts re-verified the same day. This
records the agreed direction and the reasons behind it. **The backend skeleton
(milestone M3) is implemented and tested locally, not deployed.** The
implemented contracts are in [api.md](api.md), [jobs.md](jobs.md) and
[database.md](database.md). Where this page and those disagree, those describe
the code. Product intent lives in [product-spec.md](product-spec.md),
step-by-step provisioning in [infrastructure-setup.md](infrastructure-setup.md),
device facts in [glasses-platform.md](glasses-platform.md), and the build order
in [implementation-plan.md](implementation-plan.md).

## Product boundary

Users create personal applets through an authoring chat on a phone or laptop.
They can attach context and files, preview a result, request edits, and publish
it to their glasses. The glasses home lists the latest three projects and an
Older entry. Selecting a project opens its downloaded applet.

Applets are useful to one wearer. Shared sessions, multiplayer features, external
account synchronization, and dice rolling are outside the initial scope.

The glasses run one reusable web application that interprets applet definitions.
We do not build or deploy a separate executable application for every applet.

## Decisions

| Responsibility | Decision |
| --- | --- |
| Authoring model | OpenAI GPT-6 Luna through OpenRouter (`openai/gpt-6-luna`); replaceable backend adapter |
| Application hosting | Aiven Runtime |
| Structured persistence | Aiven managed PostgreSQL; select a plan with backups and pooling |
| Files and packages | Verda S3-compatible object storage |
| Voice interpretation | Meta AI through WebMCP; no additional interpreter model |
| Glasses execution | Local rendering, action execution, navigation, and state persistence |
| Background work | Separate worker with durable jobs recorded in PostgreSQL |
| Code organization | One TypeScript repository (npm workspaces); separate API and worker entry points, one container image |
| Object traffic | Proxied through the API: Verda has no CORS or public access, so browsers never talk to it |
| Runtime language | TypeScript on Node 26 LTS (local dev works on Node 22.18+) |
| HTTP framework | Hono 4.13 on `@hono/node-server` (small, streaming request bodies, in-process test requests) |
| Database access | `pg` 8.23 with plain SQL migrations and typed query functions; no ORM |
| Request validation | zod 4.6 |
| User authentication | **Clerk** for web accounts (`AUTH_MODE=clerk`); local-only dev mode retained. Device pairing implemented; native Clerk and delegated MCP OAuth remain pending |

Start with modest capacity. Managed plan upgrades provide a growth path; automatic
horizontal scaling is not an initial requirement. Do not provision GPUs, Redis,
a vector database, or another model service without a concrete need.

### Authoring access and budget

Managed authoring uses the OpenRouter API with `openai/gpt-6-luna` as the initial
configurable model. Account/key metadata checks on 2026-11-14 succeeded without
model inference. The supplied application key has a $17 non-resetting spending
limit and expires on 2026-11-21 at 04:14 UTC. Replace it before expiry if continuing
development. The available account balance was approximately $17.59 at setup;
balances are live operational data, not a guarantee of future availability.

Backend-only local configuration is saved in `.env.openrouter.local` with mode
`0600` and is Git-ignored. `.env.openrouter.example` contains no secret. Supply the
key through Aiven runtime secrets when deploying; no hosted backend is configured
yet. Set token ceilings and bounded retries per job, record reported usage, and
handle insufficient-credit, key-limit, rate-limit, and expiry errors explicitly.
Route structured-output requests only to endpoints that support the required
parameters and validate all results locally. Luna's schema adherence and output
quality have not yet been tested with the applet contract.

The Junction OpenAI grant is Codex usage credit, not API credit. A read-only
account check on 2026-11-14 confirmed ChatGPT-authenticated Codex access and an
available Codex credit balance. This does not establish funded OpenAI API access
for the hosted generation worker.

Keep two integration paths distinct:

- Managed authoring in our hosted app uses OpenRouter's funded model API.
  Direct OpenAI API funding is not assumed; Gemini/Anthropic grants are pending
  alternatives.
- Personal authoring through a user's signed-in Codex client can produce and
  submit applet definitions through our authoring tools. A local Codex SDK or
  app-server integration is a candidate for this path, not an implemented feature.

Do not deploy the developer's personal Codex session as a shared public model
backend. The generation and worker sections below describe the managed API path.

References: [separate billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform),
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

## Runtime responsibilities

**Authoring client:** project library, chat, uploads, previews, change review, and
publishing. A preview uses the same applet validation and action semantics as the
glasses, while keeping preview state separate from real user state.

**API:** authentication, ownership checks, project metadata, upload authorization,
authoring requests, publication, package delivery authorization, and state backup.
It does not wait synchronously for an entire generation to finish.

**Worker:** processes durable jobs, prepares uploaded material, calls the authoring model through OpenRouter,
validates the applet, produces change reports, and assembles published packages.
All durable work and progress survive a worker restart.

**Glasses client:** caches the web application and applet packages, renders the
current view, registers the active applet's WebMCP tools, validates and executes
actions, and saves state locally. Band controls and WebMCP tools call the same
action executor. Our backend is outside the ordinary action loop.

**Meta AI:** handles the Hey Meta interaction and selects registered tools. This
is a separate connectivity dependency: cached applets and band actions can work
offline, but we do not promise offline Meta AI voice control.

## Fixed-page display policy

The glasses renderer permits no scrolling or panning in either axis. Applets use
complete discrete pages and explicit next/previous actions. A page may be purely
visual: text and visible metadata are optional, chosen for their usefulness to
the task. Identifiers need a recognizable description or directly associated
visual when they are shown. This includes paged
collections and separate fitted diagram/detail pages. Authoring validation must
reject content that does not fit at the supported viewport and typography,
rather than shrink it or silently clip essential information. Domain state and
saved position use stable IDs across those page changes. See
[authoring instructions](authoring-instructions.md).

## Applet contract

Model output is constrained data, not arbitrary JavaScript or a generated server.
The application supplies a fixed component catalog and a bounded set of runtime
operations. The agent composes these into an applet-specific interface and action
registry. An actual MCP server per applet is unnecessary.

A versioned definition contains:

- `formatVersion` and `minimumRuntimeVersion` for compatibility.
- Stable identifiers for views, components, state fields, collections, and actions.
- A state schema and defaults for a new user's state.
- Views and bindings to that state, plus focus order and primary controls.
- Named actions with argument schemas, descriptions, optional utterance examples,
  and effects expressed through supported operations.
- References to applet-specific assets and optional source references.

The exact component and operation catalogs remain to be specified. The first
catalog should cover text, cards, lists, counters, checklists, step navigation,
and basic forms. Generated actions can compose validated operations such as
incrementing a numeric field or adding an item to a typed collection.

WebMCP is an adapter over this registry. Only scalar parameters reach Meta AI
(`string`/`number`/`integer`/`boolean`); `enum`, ranges and nested schemas are dropped,
tool names get 57 usable characters and calls have a 10 s deadline. Its current
parameter limitations must not weaken the internal contract: prefer simple scalar tool arguments, translate
them into internal action inputs, and validate everything inside the executor.
Do not depend on the assistant enforcing JSON Schema constraints. Register only
the active applet's tools and unregister them when leaving it.

## Design and data have separate lifecycles

A component displays a field; it does not own the field's stored value. Removing
an inventory card must not delete the inventory. Moving the same data to another
view is a layout change, not a data migration.

Every authoring run produces a complete candidate revision. Only after that run
finishes do we compare it with its base revision for:

- Removed or changed state fields, collection types, or action capabilities.
- Existing information that becomes inaccessible through both UI and tools.
- Explicitly proposed data deletion or incompatible transformations.

The program determines the change set. AI may summarize verified findings in
plain language; it must not decide whether information was lost. Show related
changes together, with previous-view previews where useful. Users can accept the
changes or explain what to retain and ask for another revision.

An accepted destructive change is bound to the exact candidate revision and
change report. It cannot authorize unrelated changes in a later generation.
State migrations use validated operations; the model cannot issue SQL or mutate
live user state directly. Keep a pre-migration state snapshot. Restoring an old
layout does not implicitly roll back newer user data.

## Proposed persistence model

All user-owned records carry an owner reference. User content and mutable data
are private by default.

| Record | Purpose and important fields |
| --- | --- |
| User | External identity reference and preferences |
| Project | Owner, title, last-opened metadata, current published revision |
| Conversation / message | Authoring history and attachment references |
| Upload | Owner, object key, media type, byte size, hash, processing status |
| Applet revision | Project, base revision, definition, format version, validation status |
| Change review | Candidate/base IDs, detected impacts, acceptance or rejection |
| Asset | Owner/project, content hash, object key, media type, size |
| Release | Revision, package key/hash/size, runtime requirement, publication status |
| Generation job | Input references, status, attempts, lease, progress, error, usage |
| Device session | User/device association, revocation and synchronization identity |
| State backup | Applet/revision, schema version, device ID, sequence, snapshot, server version |

Use foreign keys, unique constraints, and transactions for ownership relationships,
publication, job claims, and duplicate-request protection. Avoid storing large
binary files in PostgreSQL. Do not put source documents or chat history into the
glasses package unless required for the applet itself.

## Generation and job execution

1. The API saves the user's message and attachment references.
2. It creates an authoring job against a specific base revision and returns its ID.
3. A worker claims the job using a database lease and a bounded concurrency limit.
4. The worker prepares context, calls the configured model through OpenRouter,
   and validates the candidate.
5. A valid candidate and its change report are saved for preview; invalid output
   receives a bounded repair attempt or a useful failure message.
6. The client retrieves progress while the authoring screen is active. Closing
   that screen does not cancel the durable job.

Proposed job states: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
An expired lease makes unfinished work eligible for recovery. Use unique job-step
identifiers and object keys so retries do not duplicate published results.
External model calls may still repeat after an ambiguous failure; cap attempts
and token spend rather than claiming exactly-once inference.

API and workers scale independently. PostgreSQL is sufficient for the initial
queue. Use leases/heartbeats and transactional claims, not an in-memory task list.

## Publication and package delivery

1. Publish an explicitly selected candidate against the expected current release.
2. Verify validation, compatibility, and any required change acceptance.
3. Create a durable packaging job.
4. Build a complete immutable package containing the definition and unique assets.
5. Upload the package and record its hash, size, and manifest.
6. In a transaction, mark the release ready and advance the project's published
   pointer only if its expected base still matches.

An upload and a database transaction are not atomic together. Publish the pointer
only after upload succeeds. Retry interrupted work; later clean unreferenced
objects. An incomplete package must never become the active release.

Shared icons, fonts, components, and common graphics ship with the application.
Applet-specific illustrations ship with the applet. Preserve asset hashes across
revisions so a later incremental-download optimization remains possible. Initially
prefer one complete package per revision over many small network requests.

Keep storage credentials server-side. **Deliver packages through an authenticated
API endpoint that streams the object from Verda.** Verda supports presigned URLs
but no CORS, so a glasses or authoring `fetch()` to a presigned Verda URL would
fail. Serving through the API also keeps everything same-origin with the glasses
app. Release packages are immutable: send `ETag: <sha256>` and
`Cache-Control: private, max-age=31536000, immutable`. Cache by release/hash on the
device, never by URL. Uploads take the same route: the authoring client streams the
file to the API, which validates type/size, hashes it and writes it to Verda.

## Minimize glasses internet use

- Open the cached library and installed applets immediately.
- Do not fetch on every view transition, band action, or state change.
- Check a small release manifest on explicit sync; avoid continuous polling.
- Download new/changed content, validate it, then activate it atomically.
- Keep the previous working release until the new one is stored successfully.
- Persist state locally before considering an action committed.
- Batch state backups at session boundaries, explicit sync, or another bounded
  policy; do not upload every individual action.

Browser storage is subject to platform support, quota, and eviction. Treat the
specific IndexedDB behavior and available quota on the glasses as hardware
verification items. Cloud backups provide recovery but cannot recover changes
that were never synchronized before local data was lost.

## State synchronization

Initially there is one active glasses writer for an applet. Mobile authoring edits
definitions, not the wearer's live values. Preview changes never overwrite them.
This avoids requiring collaborative editing or CRDTs.

Each backup has a device ID, monotonic sequence, operation ID, revision/schema
version, and expected server version. Save it transactionally. Repeating an
operation returns its previous result. Older device sequences cannot overwrite
newer ones. A conflicting device or server version returns a conflict; retain
both snapshots and do not silently merge or overwrite.

Apply a new definition to the latest local state at activation, using its approved
migration. If the installed release is not a supported migration base, keep it
working and require an explicit migration/recovery path. Cloud data may lag local
data; generation must not assume its last backup is the wearer's current state.

## API surface

Implemented; the full contract (sessions, errors, idempotency, every endpoint)
is in [api.md](api.md). The original proposal, for reference:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/projects` | Library metadata and published revision identifiers |
| `POST /v1/projects` | Create a personal project |
| `POST /v1/uploads` | Stream a file (≤ `MAX_UPLOAD_BYTES`) through the API to storage; returns upload ID and queues preparation |
| `POST /v1/projects/:id/messages` | Save an authoring message and queue generation |
| `GET /v1/jobs/:id` | Read progress/result, with ownership checks |
| `POST /v1/jobs/:id/cancel` | Request best-effort cancellation |
| `GET /v1/projects/:id/revisions/:revision` | Retrieve a candidate for preview/review |
| `POST /v1/projects/:id/reviews` | Record revision-specific change acceptance |
| `POST /v1/projects/:id/releases` | Queue publication with a base-version precondition |
| `GET /v1/projects/:id/releases/latest` | Explicit sync manifest |
| `GET /v1/releases/:id/package` | Stream the immutable package (authenticated; ETag = hash) |
| `POST /v1/devices/pair` | Exchange a short-lived one-use pairing code for a revocable device session |
| `PUT /v1/projects/:id/state` | Upload a versioned, idempotent state backup |
| `GET /v1/projects/:id/state` | Recover the last server backup |

Use request idempotency keys on job creation and publication. Return structured
errors and conflict details. Prefer conditional manifest requests for explicit
sync. No per-action server endpoint is required by normal glasses use.

## Authentication, operations, and deployment

Clerk is the selected identity/session provider. Aim for ordinary
sign-in in the authoring interface and simple glasses pairing, without entering
provider keys on the glasses. Any pairing code must be short-lived, one-use, and
exchange for a revocable device session. Do not implement a password database as
an incidental part of this project.

Authenticate API requests and enforce ownership at every data/file boundary.
Validate file type and size, model output, and tool arguments. Treat uploads and
model-generated instructions as untrusted data. Apply upload limits, generation
concurrency limits, and token budgets per user. Keep API keys out of packages,
logs, and frontend bundles.

Deploy container builds from GitHub to Aiven Runtime (`compose.yaml` + Dockerfile;
see [infrastructure-setup.md](infrastructure-setup.md#4-hosting-aiven-runtime-todo)).
Pushing doesn't redeploy: trigger "Deploy latest commit" per app. The `api` app
serves the glasses web app (`/glasses/`), the authoring web app (`/author/`) and the
API (`/v1/`) from one HTTPS origin; the `worker` app runs the same image with a
different command. Supply OpenRouter, PostgreSQL (`DATABASE_URL` via service
integration) and Verda credentials through runtime secrets. Keep temporary files
disposable. Runtime has no pre-deploy hook, so run schema migrations from the
entrypoint under a PostgreSQL advisory lock (or from CI before deploying), never
concurrently from every replica.

Use health checks, structured logs with request/job/revision IDs, and graceful
shutdown. Track job failures, model usage/cost, publication failures, database
connections, and sync conflicts. Log metadata rather than raw user documents or
transcripts. Configure backup retention and perform a restore check before
claiming production readiness. Do not infer high availability from the provider
name: select and document the actual plans.

## Open decisions and next implementation work

1. Define the component/action DSL and strict applet schema.
2. Choose authoring authentication (pairing and device sessions are done).
3. Verify glasses persistent storage, offline launch, and WebMCP behavior on hardware.
4. Select Aiven database/runtime plans and region; verify backup and pooling settings.
5. Specify state migration operations and review rules with concrete examples.
6. Define package format, size limits, and cache/version compatibility rules.
7. Implement the smallest full flow: author -> preview -> publish -> download ->
   local action -> state backup -> restore. **Backend half done:** the
   author (definition submitted directly) -> publish -> package -> download ->
   backup -> restore path passes as an integration test
   (`apps/api/src/e2e.test.ts`). Generation, preview and the glasses side are
   still to build.

## Current infrastructure and references

Verda project, bucket, and storage credentials are configured and verified; see
[Verda setup](verda.md). OpenRouter is funded and keyed. The API and worker are
implemented ([backend-development.md](backend-development.md)); Aiven
database/runtime are not yet provisioned, so nothing is deployed. Provisioning steps:
[infrastructure-setup.md](infrastructure-setup.md).

- [Aiven deployment](https://aiven.io/docs/products/runtime/deploy-apps)
- [Aiven Compose support, including worker examples](https://aiven.io/docs/products/runtime/manifest-files/compose-files)
- [Aiven HTTPS endpoints](https://aiven.io/docs/products/runtime/ports)
- [Aiven application plan changes](https://aiven.io/docs/products/runtime/scale-apps)
- [Meta WebMCP contract](https://github.com/meta/meta-wearables-webapp/blob/main/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-webmcp/SKILL.md)
  (summarized with exact limits in [glasses-platform.md](glasses-platform.md#webmcp-hey-meta-voice--our-actions))
- [Verda Object Storage](https://docs.verda.com/storage/object-storage/) (S3-compatible beta; no CORS/public buckets)
