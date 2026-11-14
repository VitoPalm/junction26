# Model pipeline test results — 2026-11-14

The managed Luna path now works across the tested common applet/source cases,
including real image packages. This is local backend/desktop-renderer evidence;
there was no deployment or hardware test. Glasses-side authoring was excluded.

## Acceptance evidence

The final acceptance selection passed **60/60 requests** at Luna's normal
`medium` reasoning effort. The selection is deliberately explicit; earlier
failures and partial results are described below rather than counted as passes.
Machine-readable results, checks, source URLs, usage, definition hashes and
package sizes: [model-pipeline-evidence.json](model-pipeline-evidence.json).

- **48/48 repeated common cases:** three passes each of counter creation and
  additive edits, D&D character tracker, interactive hiking checklist, recipe,
  Markdown pattern, CSV checklist, JSON character data, HTML pattern, Word
  pattern, Finnish counter, reference cards, longer multi-condition instructions,
  blocked private link, source prompt injection and unsupported-feature handling.
- **6/6 online-source rechecks through Verda:** three independent web searches
  followed by source reads and image imports, plus three Commons image searches
  followed by image inspection/import. Every resulting applet contained offline
  image bytes. Independent searches chose different sources, including Scouts,
  Royal Museums Greenwich and Animated Knots; this was not a hardcoded URL path.
- **6/6 final Verda creation/edit checks:** counter creation and edit, Word import,
  two attached text sources, source-image creation and an edit adding a counter.
  The image edit kept every existing image ID and its exact bytes. Migrating a
  counter with a live value of 12 retained 12. Offline comparisons also confirmed
  that all original counter action IDs, effects, argument schemas and state types
  survived the three common-suite edits and the final Verda edit.

The common suite used the real Hono server over loopback HTTP, isolated migrated
PostgreSQL databases, production job handlers, real OpenRouter and the canonical
runtime/renderer. The final two Verda suites additionally used real S3 storage,
paired a device, verified downloaded package SHA-256 values and round-tripped
state backups. Temporary Verda uploads, sidecars and release objects were removed
from those isolated benchmark runs.

A preceding Verda pass also successfully prepared the full recorded TROTTEN PDF,
published its diagram assets, imported an attached diagram, followed a direct
source URL, executed crop_image, combined sources and retained images across an
edit. It completed 11 requests, with one partial result: search produced a
truthful text-only fallback instead of the requested image. That led to the
source-round fix and the six successful online-source rechecks above. The
TROTTEN package was about 1.2 MiB, depending on selected views/assets.

Pass conditions include expected candidate vs. clarification outcome, schema and
render checks, offline asset presence/provenance for visual cases, selected source
quantities/conditions, a working checklist toggle, counter increment and state
migration. They are not a complete automatic proof of factual correctness.
A few generated outputs and source/diagram selections were inspected during
iteration; all safety-critical/industrial guides still need source review.

## What the testing changed

The initial real-model run failed to produce a valid PDF applet after repair and
asked to re-upload an image that had already been attached. It also invented a
minimum runtime version and repeatedly omitted required state defaults. Later
runs exposed unusable custom docks on list pages, a checklist missing its toggle
wiring, overlong copy, and source facts/images lost between tool use and repair.

The implemented fixes are:

- Prepared text and normalized page/image refs, instead of opaque PDF forwarding.
- Public-link reads, bounded web search, Commons image search and source crops.
- Server-side image-ref resolution with offline bytes and provenance; no invented
  base64 or arbitrary upload access.
- Explicit required-property examples, correct runtime version, dock/checklist
  validation, and up to two repairs retaining the source-tool conversation.
- A canonical 600×600 renderer check on every generated view/step/list page,
  including menu pages. Fit errors feed back to Luna before a revision is saved.
- A source loop that can use all eight allowed tool executions, including after
  a failed website, rather than stopping after only four rounds. Public fetches
  use HTTP/1.1 to avoid an observed HTTP/2 stream failure on a source site.
- Explicit Word extraction warnings; the model no longer needs to pretend that
  absent imported drawings mean the original document had none.
- Broader phone file-picker/MIME support and bounded processing/network paths.

Details and reproduction commands: [model-pipeline.md](model-pipeline.md).

## Spend and checks

Across baseline, tuning, repairs, failed/partial cases and acceptance runs:

- **188 paid model calls**, including paid web-search calls.
- Sum of provider-reported per-call costs: **$0.095571495** (about **$0.10 of $3**).
- Key usage delta at the end: **$0.09424226**. This is $0.001329235 lower than the
  per-call sum; the provider's accounting surfaces do not exactly reconcile at
  that observation. Use the larger per-call amount for this work's budget.
- The final default-effort common suite needed 51 paid calls for 48 requests;
  three requests needed a repair. Repairs remain bounded, not a guarantee that
  arbitrary future prompts will succeed.

`npm run build`, `npm run typecheck` and the full `npm test` suite (102 tests) passed with
PostgreSQL enabled and no skipped tests. The container builds successfully and
its Chromium/canonical-renderer, native Sharp/ingest, and full 16-page TROTTEN
PDF-rendering smoke checks pass.

Raw requests, responses, paid-call ledger and detailed test/build logs remain in
ignored `.data/model-bench/`; the evidence summary contains no
keys or document bytes. Ordinary unit tests do not make paid calls.

Remaining adjacent issues were recorded without broadening this task:
[model-pipeline-followups.md](model-pipeline-followups.md). The most consequential
are direct revision/publication bypasses, numeric step-position migration,
duplicate list labels, mutable-value fit and listUpdate validation. Source/file
limitations and the need for on-device readability checks remain explicit.

During final verification, another thread added the external-assistant/MCP workspace in the shared tree. Its initial empty-workspace build interruption was transient. After correcting a fit-checker DOM-type leak, the repository-wide build, typecheck and all 102 tests passed. Those concurrent assistant features were not part of this pipeline task.
