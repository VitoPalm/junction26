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
| Aiven PostgreSQL + Runtime | Not provisioned |
| Applet format v1 (general, beyond guides) | **Draft below**, not implemented |
| Backend: API, worker, DB schema, storage adapter (`apps/api`, `apps/worker`, `packages/db`, `packages/storage`, `packages/server-common`) | **Built (M3 skeleton)**, tested against PostgreSQL 18 locally, container image builds. Not deployed. User auth is a dev placeholder; generation is a placeholder ([backend-development.md](backend-development.md)) |
| Applet format v1 + runtime + renderer (`packages/applet-format`, `applet-runtime`, `applet-renderer`) | **Built (MVP)**, unit-tested; see [apps.md](apps.md) |
| Model adapter (`packages/model`) + real `generate_revision` | **Built**: OpenRouter / OpenAI-compatible / free `fake` provider, swappable by spec. Luna not yet run against the format |
| Glasses app (`apps/glasses`): library, runtime host, IndexedDB, sync, pairing, WebMCP, SW | **Built (MVP)**, checked in headless Chrome at 600×600; not on hardware |
| Authoring app (`apps/author`): web + Capacitor iOS/Android | **Built (MVP)**, checked in Chrome and the Android emulator; iOS project generated, not built |
| Ingest (PDF rendering, diagram assets), change-review endpoint, measured fit at publish | Not implemented |
| Hardware verification (WebMCP, storage, band, readability) | Not done |

The experiments contain copies of the component library (`experiments/*/app/src/lib`)
frozen at trial time. **`packages/glasses-ui` is canonical.** Keep the
`openrouter-ikea-v2` copy in sync only while it serves as the live demo.

## Target repository layout

```text
apps/
  api/            [exists] Node HTTP server: /v1 API (+ will serve glasses/ and author/ static builds)
  worker/         [exists] Node job runner (same image, different entry point)
  glasses/        React + Vite web app for MRBD (library, runtime host, WebMCP adapter, SW)
  author/         React + Vite PWA for phone/laptop (library, chat, uploads, preview, review)
packages/
  glasses-ui/     [exists] display components on @wearables-ui-toolkit/mrbd
  applet-format/  types + JSON Schema + validators + fit/copy rules (shared by everyone)
  runtime/        pure state machine: dispatch(action, args) → new state; used by glasses AND preview
  diff/           revision comparison → change report (data-loss detection)
  db/             [exists] SQL migrations + typed queries
  storage/        [exists] S3 adapter (Verda today), fs + memory for dev/tests
  server-common/  [exists] env config, logger, shutdown, interim definition check
  model/          OpenRouter adapter (structured output, usage, errors)
  ingest/         PDF/image preparation (render pages, extract text, crop, ink)
experiments/      frozen trials and evidence; do not build product code here
docs/
```

Suggested libraries (latest stable versions on 2026-11-14): React 19.3,
react-router-dom 7.18, Vite 8.3 + @vitejs/plugin-react 6.3, TypeScript 7.0,
Playwright 1.65, zod 4.6 or ajv 8.20 (for JSON Schema), pg 8.23, @aws-sdk/client-s3 3.x,
Fastify 5.12 or Hono 4.13 for HTTP. Use plain SQL migrations and avoid a heavy ORM.
Workspaces are already set up at the root `package.json`.

## Applet format v1 (draft to finalize in milestone 1)

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
(`j26_<prefix>_<action>`), plus generic navigation tools (`..._next`,
`..._previous`, `..._open_view`). Unregister on leaving. Coerce and validate
arguments in `runtime.dispatch`. Return `{ ok, summary, next_action }`.

## Milestones (build in this order)

Each milestone ends with its acceptance checks passing and the docs updated.

### M0. Feasibility on real glasses (half a day, when hardware is available)

Deploy a static "hello" page (any HTTPS host) that registers one WebMCP tool and
writes to IndexedDB. Verify "Hey Meta" invokes it, IndexedDB survives a close
and a reboot, `navigator.storage.estimate()` reports a quota, band focus/select
works, and a 1 MB download takes an acceptable time. **If WebMCP isn't
available or Meta AI never invokes a registered tool, report the blocker**:
the voice path is unverified. Until hardware is available, continue the
runtime, manual controls and desktop checks; do not mark M0 complete or promise
device voice behavior. See [WebMCP audit and verification plan](webmcp-audit.md).

### M1. Applet format + runtime (no network)

`packages/applet-format`, `packages/runtime`. Port the IKEA guide and write
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

**Status 2026-11-14:** code done; infrastructure not. Built: schema + migrator,
storage adapter, every endpoint except change reviews and static hosting,
device pairing, durable job runner with lease recovery, packaging/publish,
state backup, Dockerfile + compose. Tests cover ownership checks, idempotency
keys and lease recovery (simulated by an expired lease rather than literally
killing a process). Remaining: provision Aiven, deploy, choose user auth (open
decision 1), verify `/readyz` in deployment.

Provision Aiven PG + Runtime per [infrastructure-setup.md](infrastructure-setup.md).
`apps/api`, `apps/worker`, `packages/db` (tables from backend-architecture),
`packages/storage`. Auth: pick the mechanism (see open decisions) and pairing
codes for glasses. Endpoints: projects, uploads (streamed), jobs, releases,
package download, state backup. Acceptance: deploy from GitHub; `/readyz`
green; integration tests for ownership checks, idempotency keys, job lease
recovery after killing a worker mid-job.

### M4. Authoring pipeline as a service

`packages/ingest` (port `experiments/openrouter-ikea-v2/run.py` + `bundle.py` +
the in-browser `inkify` logic to Node; Poppler via the container or pdfjs) and
`packages/model`. The worker runs prepare → generate → validate → (one bounded
repair attempt) → candidate + change report. System prompt =
`docs/authoring-instructions.md` + format contract + capability catalog.
Acceptance: the TROTTEN manual produces a valid candidate end to end; usage and
cost recorded per job; failures produce a useful message.

### M5. Authoring client

`apps/author`: library + plus button, first-run capability popup, chat with
attachments, job progress, preview (same runtime, separate preview state),
change review screen (diff findings, before/after previews, AI-written one-line
explanations, accept all / explain what to keep), publish. Acceptance:
create → edit → publish loop on a phone browser.

### M6. Publish → sync → backup

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
[assistant-integrations.md](assistant-integrations.md) (2026-11-14; proposal,
not implemented or tested in assistant clients).

## Open decisions (owner input needed)

1. Authentication for the authoring client (passkeys / OAuth provider / magic
   link) and the glasses pairing UX.
2. Aiven region and exact plans (Startup PG recommended); when to upgrade for HA.
3. Whether to subsidize the first applet and with which credits.
4. Package size limit and whether to downscale or WebP-encode diagrams at
   packaging time (likely yes: the glasses download at ~500 Kbps).
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
