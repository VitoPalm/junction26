# OpenRouter trial v2: choose the useful representation

One fresh call to `openai/gpt-6-luna`, medium reasoning, through the same real
OpenRouter API and deterministic PDF preprocessing as the first API trial. Same
16-page document and user request. No earlier candidate or manual-specific
corrections were supplied. The generic guidance and representation schema both
changed, so this is not a controlled attribution to prompt wording alone.

## Changes supplied to the model

The repository-wide policy in `docs/authoring-instructions.md` now prioritizes
usefulness and minimal presentation across tasks. Visuals can stand alone;
redundant prose and captions are discouraged. Identifiers should help the user
recognize or distinguish their referents and need a description or direct visual
context. Internal IDs and provenance are not automatically visible UI. The
no-scroll and source-fidelity requirements remain.

The schema now permits image views with null body/hint and optional visible
title, as well as text-only views when useful. The old required-text schema could
not express this behavior. The fixed renderer now honors those choices directly,
without manufacturing an extra prose view or displaying source-page captions.
The source references remain in the JSON for inspection.

## Result and evidence

- One complete, schema-valid response; no retries or evaluator corrections.
- API round-trip 42.00 seconds; reported model cost $0.0068148.
- Reported input tokens 37,355; completion tokens 4,291, including 2,284 reasoning.
- 17 distinct image views, 13 per selected desk size. No body/hint text views.
- The output still supplies visible titles on all 17 views.
- Build/typecheck and six host/unit tests passed. Four headless Chrome cases
  traverse both size branches at 600×600 and 480×480, checking image loading,
  image bounds, absence of body paragraphs, no wheel scrolling, and resume.
- Existing browser state remains separate from the v1 trial.

Exact evidence: `guidance.md`, `system-prompt.txt`, `user-prompt.txt`,
`schema.json`, `input-manifest.json`, `request.json`, `response.json`,
`request-metrics.json`, `candidate.json`, and `validation.json`. The request
record replaces embedded image bytes with manifest references and contains no
credentials. `candidate.json` is unedited model output.

## Remaining failures

This candidate is not accepted as verified assembly guidance.

- Every view still has a heading, despite titles being optional and the policy
  discouraging redundant headings. Some are unnecessary; the page-4 heading
  "Build both leg frames" continues to conflate the completed-assembly inset
  with the actual numbered bolt-insertion action.
- The source's pictorial safety/preparation guidance on PDF page 2 is absent.
  The model reports no uncertainties. Choosing visuals must not mean dropping
  essential source guidance.
- Three crops were visually inspected directly. The step-7 crop reaches a tool
  drawing at the bottom boundary; the step-8 crop contains a small fragment from
  the previous step. Region bounds being valid is not proof of good selection.
- The source's part codes remain directly attached to their diagrams, rather
  than being serialized into a separate unexplained paragraph. Real-device
  label legibility and whether large source views need further detail pages
  remain unverified.

## Demo and reproduction

The candidate is served at http://127.0.0.1:4182/ by the user service
`junction26-glasses-demo-v2`. Open it in Chrome and enable the existing Meta
Display simulator extension for that tab. No extra cloud infrastructure was
provisioned. The old demo remains at port 4180.

`run.py` makes a paid API call and refuses to overwrite an existing response.
`bundle.py` crops/inverts source line art deterministically, without another model
call. `app/` contains the fixed renderer and local assets. Its dependencies are
symlinked to the shared library's node_modules; replace with npm ci for a separate
installation. The generation model never authored or executed renderer code.

## Subsequent readability treatment

The shared runtime now wraps diagrams and static text in a Panel material and
adds stronger diagram strokes/glow. Component backdrop blur is requested via CSS;
it does not imply optical blur of the real world. The simulator was inspected
with its scene blur at 0. The generated candidate and original crop assets remain
unchanged; this is a deterministic runtime presentation change.

## Later changes to the demo (no new API call)

- 2026-11-14: Codex added component blur/material surfaces and diagram glow for
  readability. They had no effect on the additive display and were replaced by the
  `inkify` diagram renderer, heavier typography and bold button labels (see
  `packages/glasses-ui/README.md`, "Additive display readability"). The demo's
  `src/lib` mirrors the canonical library.
- The image browser test compares `data-src` (the source asset) because the
  displayed `src` is now a generated object URL.
- The app is an npm workspace: run `npm ci` at the repository root.
