# Adjacent findings from model-pipeline work

Found 2026-11-14. Deliberately left for follow-up unless noted as fixed in the
pipeline. These are separate from on-device verification and glasses authoring,
which remain outside this work.

## Integrity / publication

- **Direct revisions bypass full format checks.**
  `apps/api/src/routes/authoring.ts` still calls the interim
  `packages/server-common/src/definition.ts` checker, which accepts incomplete
  applets and formatVersion 2. The glasses validator supports version 1.
  Existing API integration tests intentionally publish examples like
  `{formatVersion:1,title:"one"}`. Model-generated candidates now receive the full
  validator, source resolution and fit checks; direct submissions still do not.
- **Change acceptance is client-side.** The phone's destructive-change checkbox
  is not a server-enforced review bound to the candidate. A direct client can
  publish around it. Do not describe the current UI as an enforced no-data-loss
  guarantee.
- **Guide position migration uses an index, not the step ID.**
  `migrateState` in `packages/applet-runtime/src/index.ts` carries/clamps numeric
  cursor values. Insert a step before the saved position and the same index now
  points at different content, even when the model preserves every step ID.
  Reordering guides needs a step-ID migration policy.
- **List item selection is by display text.** The renderer passes the selected
  item's display value to the action, and the runtime picks the first exact
  match. Two items with the same label can cause selecting the second to mutate
  the first. Use stable item IDs for UI selection while keeping name matching
  for voice. The generated packing fixtures have distinct names, so the paid
  selection checks do not exercise duplicates.
- **listUpdate bypasses string-length checks.** Runtime append checks each
  string's maxLength; listUpdate writes converted values without the equivalent
  check. Voice edits can produce content the renderer refuses to show. Numeric
  list updates can also produce non-finite values from unsuitable strings.

## Operations / product behavior

- Dev sign-in, deployment, identity choice, per-user generation/upload limits,
  and the 2026-11-21 OpenRouter key expiry remain unchanged. New per-job source
  and tool budgets are not public-service abuse controls.
- `home.primaryAction` remains informational: the glasses do not focus it on
  entry. Luna now creates useful actions; the host still needs to implement the
  intended silent-pinch starting focus.
- Default-state fit checking cannot prove all later user values fit. Growing
  counters, later list strings, unusual Unicode and user edits still need
  runtime guards and useful authoring feedback. The guards already surface an
  error rather than scrolling; recovery UX remains basic.
- Model fit failures are repaired before saving, but publish does not rerun the
  renderer against arbitrary client revisions. Render checks use desktop Chrome,
  not glasses typography/performance/storage guarantees.
- Diagram ink processing is designed for line art. A successfully imported photo
  is not proof of good additive-display readability. Dense full-manual pages
  also need a visual audit and appropriate overview/detail crops.
- Whole-image base64 lives in revision JSON and every full package. The TROTTEN
  package is roughly 1.2 MiB (varies by model selection), which is a substantial
  initial transfer at the documented glasses bandwidth. Content-addressed assets,
  package size limits and incremental sync remain future work.
- The API accepts uploads up to 50 MiB while authoring preparation currently
  supports 12 MiB. Uploads over the processing limit fail with an excerpt request
  after transfer. Align the picker/API limits or show the lower processing limit
  before uploading.
- Source history currently reloads all earlier conversation uploads (bounded at
  20), even after the user replaces a source. Add explicit source inclusion /
  replacement controls before large multi-document conversations.
- Cached source sidecars require garbage collection along with original uploads.
  The benchmark's Verda cleanup handles its own files, but product-wide orphan
  cleanup is not implemented here.
- Word is text-only; XLSX, HEIC, legacy Word, audio, videos, JavaScript-only pages,
  private links, paywalls and manuals above the explicit limits need additional
  import paths. No unsupported source is claimed to have been imported.
- Cost reporting after cancellation, process death or an ambiguous paid-provider
  failure can miss actual spend. Normal successful generations and validation
  repairs report known usage; reconcile provider request IDs for billing.
- No CI exists yet. The suite needs PostgreSQL; render checks additionally need
  the worker bundle, Poppler for source tests and Chromium. Container validation
  and desktop tests do not replace signed native releases or hardware tests.
