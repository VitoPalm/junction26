# Implementation plan

For an engineer or agent starting cold. Read in this order:
[product-spec.md](product-spec.md) → this file →
[backend-architecture.md](backend-architecture.md) →
[glasses-platform.md](glasses-platform.md) →
[infrastructure-setup.md](infrastructure-setup.md) →
[authoring-instructions.md](authoring-instructions.md) →
[experiments.md](experiments.md).

## Where things stand (2026-11-14)

| Area | State |
| --- | --- |
| Product and architecture decisions | Agreed and documented |
| Glasses UI component library (`packages/glasses-ui`) | **Built**: fixed pages, no scrolling, fit guard, additive-display ink for diagrams, tests |
| Authoring pipeline proof (PDF → Luna via OpenRouter → validated JSON → rendered guide) | **Proven** in `experiments/openrouter-ikea-v2` (local scripts, not a service) |
| Verda bucket + credentials, OpenRouter key | **Provisioned** |
| Aiven PostgreSQL + Runtime | **Provisioned** 2026-11-14: `j26-pg` + `api`/`worker` apps in Google europe-west4 ([infrastructure-setup.md](infrastructure-setup.md)) |
| Backend: API, worker, DB schema, storage adapter (`apps/api`, `apps/worker`, `packages/db`, `packages/storage`, `packages/server-common`) | **Built**, tested against PostgreSQL 18 locally, container image builds. Deployment health remains to verify. Clerk web auth and scoped MCP OAuth are implemented; generation uses the model adapter ([apps.md](apps.md)) |
| Applet format v1 + runtime + renderer (`packages/applet-format`, `applet-runtime`, `applet-renderer`) | **Built (MVP)**, unit-tested; see [apps.md](apps.md) |
| Model adapter (`packages/model`) + real `generate_revision` | **Built**: OpenRouter, compatible endpoints, Anthropic, Gemini and free `fake`, swappable by spec. Real Luna evidence in [model-pipeline-results.md](model-pipeline-results.md) |
| Glasses app (`apps/glasses`): library, runtime host, IndexedDB, sync, pairing, WebMCP, SW | **Built (MVP)**, checked in headless Chrome at 600×600; partial hardware voice evidence, full flow open |
| Authoring app (`apps/author`): web + Capacitor iOS/Android | **Built (MVP)**, checked in Chrome and the Android emulator; iOS project generated, not built |
| Model-side source ingest, public links/image search, generated-image packaging, measured fit | Built and paid-tested locally; [pipeline and evidence](model-pipeline.md). Server-side change review and direct-publish fit validation remain open |
| Hardware verification (WebMCP, storage, band, readability) | Partial voice evidence: logged diagnostic read and owner-confirmed app success; remaining checks open ([audit](webmcp-audit.md)) |

The experiments contain copies of the component library (`experiments/*/app/src/lib`)
frozen at trial time. **`packages/glasses-ui` is canonical.** Keep the
`openrouter-ikea-v2` copy in sync only while it serves as the live demo.

## Current repository layout

Motion follow-up (2026-11-14): short looping GIFs now work in image/sequence
components, with bounded GIF upload preparation and a local video-snippet CLI.
Owner priority is YouTube links, with no on-glasses playback controls. Automated
YouTube import and model-selected snippets remain to integrate; see
[video-tutorials.md](video-tutorials.md).

```text
apps/
  api/            HTTP API, authenticated /mcp and static /glasses/ + /author/ hosting
  worker/         durable job runner, source preparation, generation and fit checks
  glasses/        offline library, runtime host, WebMCP, pairing and explicit sync
  author/         web authoring + Capacitor Android/iOS shells and phone recorder
  assistant-mcp/  shared authoring tools and private stdio adapter
packages/
  glasses-ui/     canonical fixed-page display components
  applet-format/  schema, validation, change diff, prompt, capability catalog, fixtures
  applet-runtime/ pure state machine and state migration
  applet-renderer/ React rendering, session and WebMCP adapters
  db/             append-only migrations and typed queries
  storage/        S3, filesystem and memory object-store adapters
  server-common/  env config, logging, shutdown, legacy structural-check utility
  model/          provider-neutral generation, tools and transcription adapters
experiments/      frozen trials and evidence; do not build product code here
docs/
```

Dependency versions are pinned in workspace manifests and the lockfile. The
original implementation choices were: React 19.3,
react-router-dom 7.18, Vite 8.3 + @vitejs/plugin-react 6.3, TypeScript 7.0,
Playwright 1.65, zod 4.6 or ajv 8.20 (for JSON Schema), pg 8.23, @aws-sdk/client-s3 3.x,
Fastify 5.12 or Hono 4.13 for HTTP. Use plain SQL migrations and avoid a heavy ORM.
Workspaces are already set up at the root `package.json`.

## Applet format v1 (historical draft; implemented contract in apps.md)

The draft below records the original design, not the current wire schema.
Use [apps.md](apps.md#applet-format-v1) and `packages/applet-format/src/schema.ts`
for the implemented contract; the runtime is `packages/applet-runtime`.

Design rules (from the product spec): data not code; **views, state and
actions are separate**; every element has a stable `id`; no scrolling (every
view must fit at 600×600, measured); visual-first; WebMCP gets scalar arguments
only.

```ts
interface AppletDefinition {
  formatVersion: 1;
  minimumRuntimeVersion: string;          // semver of apps/glasses runtime
  id: string;                             // stable across revisions
  title: string;                          // ≤32 chars
  toolPrefix: string;                     // e.g. "dnd" → WebMCP names "j26_dnd_..."; keep names ≤57 chars
  state: Record<string, StateField>;      // the data; survives layout edits
  actions: Record<string, ActionDef>;     // the only way state changes
  views: ViewDef[];                       // ordered; first is the entry view
  home: { primaryAction?: string; focusOrder?: string[] };
  assets: Record<string, AssetRef>;       // applet-specific images, content-addressed
  sources?: SourceRef[];                  // provenance (page, region) for review only
}

type StateField =
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean; label: string }
  | { type: 'text'; default: string; maxLength: number; label: string }
  | { type: 'boolean'; default: boolean; label: string }
  | { type: 'list'; item: Record<string, ScalarField>; default: object[]; maxItems: number; label: string }
  | { type: 'cursor'; over: string; default: 0; label: string };   // position in a sequence (guide step)

// Effects are a closed set of operations. The model composes them; it never writes code.
type Op =
  | { op: 'add'; field: string; by: number | { arg: string } }          // clamps to min/max
  | { op: 'set'; field: string; value: Scalar | { arg: string } }
  | { op: 'toggle'; field: string }
  | { op: 'listAppend'; field: string; item: Record<string, Scalar | { arg: string }> }
  | { op: 'listRemove'; field: string; match: { key: string; equals: { arg: string } } }
  | { op: 'listUpdate'; field: string; match: {...}; set: Record<string, Scalar | { arg: string }> }
  | { op: 'move'; field: string; by: 1 | -1 }                            // cursor next/prev
  | { op: 'goto'; view: string };

interface ActionDef {
  label: string;                         // button text ≤28
  description: string;                   // becomes the WebMCP tool description (≤1024)
  args: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean'; description: string; required?: boolean }>;
  effects: Op[];
  examples?: string[];                   // utterances; help the assistant and the generator
  readOnly?: boolean;
}

type ViewDef = { id: string; title?: string; actions?: string[] /* ≤2 docked */ } & (
  | { kind: 'image'; asset: string }                                     // Diagram, fitted
  | { kind: 'text'; label?: string; text: string; hint?: string }        // TextBlock
  | { kind: 'value'; field: string; hint?: string }                      // ValueReadout
  | { kind: 'list'; field: string; display: string; onSelect?: string }  // ChoiceScreen, paged by 3
  | { kind: 'checklist'; field: string }                                 // ChecklistScreen, paged by 3
  | { kind: 'sequence'; cursor: string; steps: SequenceStep[] }          // guide: one step per page
);
```

Mapping to existing components in `packages/glasses-ui`: `image` → `Diagram`,
`text` → `TextBlock`/`InstructionScreen`, `value` → `ValueReadout`, `list` →
`ChoiceScreen`, `checklist` → `ChecklistScreen`, docked actions → `ActionBar`.
The IKEA trial schema (`experiments/openrouter-ikea-v2/schema.json`:
`commonSteps` + `variants`, image or text views with source regions) is the
proven special case of `sequence`; keep it working through v1.

Validation pipeline (shared by worker, preview and glasses): JSON Schema →
referential integrity (every field/action/asset/view id resolves) → copy budgets
(`COPY_LIMITS`) → op type checks against state field types → WebMCP name length
and reserved names → **measured fit** (render each view headless at 600×600 and
480×480; any `role=alert` fit error rejects) → package size budget.

WebMCP adapter: for the open applet, register one tool per action
(`j26_<prefix>_<action>`), plus built-ins (`read_state`, `open_view`,
`next_step`, `previous_step`, with the same applet prefix). Keep one
registration per open applet across screen transitions; unregister on leaving.
Coerce and validate
arguments in `runtime.dispatch`. Return `{ ok, summary, next_action }`.

## Milestones (build in this order)

Each milestone ends with its acceptance checks passing and the docs updated.

### M0. Feasibility on real glasses (half a day, when hardware is available)

**Status 2026-11-14: voice read logged; actual app success confirmed by owner.**
After the diagnostic retry, the owner installed the actual Applets build and
reported that it worked. Exact commands/results were not supplied; repeated
write/readback checks and the remaining M0 checks are still open.
A later Scoreboard diagnostic retry logged `scoreboard_read_score({})` on
hardware at 15:38:06 UTC after renaming and simplifying the command phrases.
Earlier, on the team's device (v130, en-US),
`document.modelContext` exists and tools register and enumerate, but Meta AI
did not invoke them, with Meta's own sample too. Details in
[webmcp-audit.md](webmcp-audit.md#hardware-result-2026-11-14-registered-never-invoked).
Storage, band and download checks are still to do. Contingency: an
always-listening phone bridge over the glasses' beamformed HFP mic, see
[voice-fallback.md](voice-fallback.md).

Deploy a static "hello" page (any HTTPS host) that registers one WebMCP tool and
writes to IndexedDB. Verify "Hey Meta" invokes it, IndexedDB survives a close
and a reboot, `navigator.storage.estimate()` reports a quota, band focus/select
works, and a 1 MB download takes an acceptable time. **If WebMCP isn't
available or Meta AI never invokes a registered tool, report the blocker**:
record the failed invocation separately from successful sessions. Continue
manual controls and desktop checks while collecting the remaining device
evidence; do not mark M0 complete based on the voice result alone. See [WebMCP audit and verification plan](webmcp-audit.md).

### M1. Applet format + runtime (no network)

`packages/applet-format`, `packages/applet-runtime`. Port the IKEA guide and write
two hand-made applets (D&D tracker without dice; crochet counter + pattern
steps) as fixtures. Acceptance: unit tests for every op (clamping, list match,
cursor bounds), validation rejects broken references, all fixtures render in the
simulator with no fit errors at 600 and 480.

### M2. Glasses app shell (offline-first)

`apps/glasses`: home = latest 3 projects + "Older" (paged); open applet; runtime
host; state in IndexedDB (write before acknowledging an action); service worker
precache; WebMCP adapter; band focus order from `home.focusOrder`. Load fixtures
from a bundled manifest for now. Acceptance: warm launch makes **0 network
requests**; state persists across reload; every action works via button and via
a test stub of `document.modelContext`; Meta perf budgets met (first load
< 300 KB).

### M3. Backend skeleton + infrastructure

**Status 2026-11-14:** backend and static hosting implemented; Aiven resources
provisioned. Clerk web and MCP authentication are implemented. Tests cover
ownership, idempotency and lease recovery (simulated expiry, not a killed
process). Remaining: healthy deployment evidence, production configuration and
complete server-side change-review acceptance. See [infrastructure](infrastructure-setup.md).

Deploy and verify Aiven PG + Runtime per [infrastructure-setup.md](infrastructure-setup.md).
`apps/api`, `apps/worker`, `packages/db` (tables from backend-architecture),
`packages/storage`. Auth: Clerk accounts/OAuth and pairing codes for glasses. Endpoints: projects, uploads (streamed), jobs, releases,
package download, state backup. Acceptance: deploy from GitHub; `/readyz`
green; integration tests for ownership checks, idempotency keys, job lease
recovery after killing a worker mid-job.

### M4. Authoring pipeline as a service

**Status:** implemented in `apps/worker/src/sources.ts`, `authoring-tools.ts`,
`generate.ts` and `fit.ts`, using `packages/model` and Poppler. The worker runs
prepare → generate → validate and measure fit → up to two repairs → candidate.
Server-side change-report generation for this path remains open. See
[managed pipeline](model-pipeline.md) and [recorded evidence](model-pipeline-results.md). System prompt =
`docs/authoring-instructions.md` + format contract + capability catalog.
Acceptance: the TROTTEN manual produces a valid candidate end to end; usage and
cost recorded per job; failures produce a useful message.

### M5. Authoring client

**Status:** MVP implemented; client review exists, server-side acceptance is
incomplete. Native sign-in has code but needs end-to-end verification.

`apps/author`: library + plus button, first-run capability popup, chat with
attachments, job progress, preview (same runtime, separate preview state),
change review screen (diff findings, before/after previews, AI-written one-line
explanations, accept all / explain what to keep), publish. Acceptance:
create → edit → publish loop on a phone browser.

### M6. Publish → sync → backup

**Status:** implemented and checked locally with the real API/worker and browser;
the complete hardware acceptance flow below remains open. State migration runs
on opening an installed revision, rather than during package installation.

Packaging job (immutable package with unique assets, hash, manifest), publish
pointer advanced transactionally, glasses explicit sync (manifest check → download
→ validate → atomic activate, keep previous), state migrations on activation,
batched state backup with device sequence and conflict handling. Acceptance: the
end-to-end flow from backend-architecture "next implementation work" item 7
passes on hardware: author → preview → publish → download → local action →
state backup → restore.

### M7. Bring-your-own assistant (stretch)

An MCP server exposing authoring tools (`list_capabilities`, `create_applet`,
`revise_applet`, `validate`, `publish`) so ChatGPT/Codex/Claude/local models can
author. Same validation and change review apply.

Integration research and proposed tool/service boundaries:
[assistant-integrations.md](assistant-integrations.md). Status (2026-11-14): the
shared MCP tool set (capabilities, list/get, validate, create/revise draft; no
publish) is implemented in `apps/assistant-mcp` and served by the API at `/mcp`
behind Clerk OAuth (`applets:read`, `applets:draft`). Verified locally with a real
Clerk consent flow; not yet deployed over HTTPS or tested inside Claude/ChatGPT.
See [assistant-mcp.md](assistant-mcp.md).

## Open decisions (owner input needed)

1. Authentication provider **decided: Clerk**. Web sign-in and session verification
   are implemented and verified locally with the development instance; production
   configuration and native sign-in verification remain. Delegated MCP OAuth is implemented
   and verified locally ([assistant-mcp.md](assistant-mcp.md)).
   See [authentication-plan.md](authentication-plan.md).
2. Aiven region/resources are recorded in [infrastructure](infrastructure-setup.md).
   Backup/restore evidence, pooling configuration and when to upgrade for HA remain.
3. Whether to subsidize the first applet and with which credits.
4. Global package size limit and further image encoding/transfer optimization.
   Source normalization and bounded GIF preparation are implemented; packages
   embed resolved image bytes. The glasses download at ~500 Kbps.
5. Safety-critical sources (machinery, electrical): require explicit
   source-fidelity review UI before publishing?

## Non-negotiables (checked in review)

- No scrolling or panning anywhere on the glasses. Overflow is a validation error.
- Never delete or hide user data silently. The program detects losses, the user decides.
- No secrets in frontend bundles, packages or logs. Browsers never talk to Verda.
- The glasses make no network request for ordinary use.
- Validate all model output and all WebMCP arguments locally.
- Don't claim hardware behavior is verified unless it was tested on the device.
- Paid API scripts must refuse to re-run over recorded evidence (see `run.py` guard).
