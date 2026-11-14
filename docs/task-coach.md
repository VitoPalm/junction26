# Task coach (assembly manuals)

Status (2026-11-14): **smallest working version built**, checked with mocks,
the free fake model and desktop Chrome. **Not checked on the glasses, in the
Meta simulator extension, with Meta AI, with a real model, or against a live
PostgreSQL-backed API/worker** (see [Evidence](#evidence)).

A guide made from a furniture-assembly manual that shows one step at a time,
answers questions about the current step from the manual, handles a reported
problem with a confirmed recovery branch, and keeps progress offline.

## What the wearer gets

- **One step per page**: instruction, page reference (`Step 5 of 9 · p. 3`), and
  one line for what's unclear in the manual, its caution, the step's tip or the
  parts it uses. Image steps show their diagram.
- **Dock**: Previous / Next (Complete on the last step). **More** opens Repeat,
  Show parts, Ask a question, Report a problem, Complete step (or Stop this fix).
  Menus page three choices at a time; nothing scrolls.
- **Ask**: presets ("Which parts do I need?", "Anything to be careful of?",
  "How many steps are left?") or typed/dictated text. Parts, warnings, progress
  and repeat are answered **on the device** from the structured guide. Anything
  else becomes a background request; the screen shows "Checking the manual"
  with Cancel, and the answer appears with its page. If the manual doesn't
  establish it, the answer says so.
- **Report a problem**: presets or free text. The coach may ask one clarifying
  question (options on screen), then proposes a fix: title, why, number of steps,
  sources and the step it returns to. **Nothing changes until the wearer chooses
  "Use this fix".** The fix runs as its own short path (`Fix 1 of 3`) and then
  returns to the original guide. Cancelling returns to where the problem was
  reported. Completed steps and the original guide are never changed.
  Damage, injury, electrics or stability reports get "stop and contact the
  retailer" without a model call; missing parts go back to the retailer too.
- **Voice** ("Hey Meta, …", via WebMCP; unverified on hardware): every item above
  has a tool, and every tool has a band path.

## How it fits the architecture

```text
phone upload ─► generate_revision (model adapter; fake:demo → bookcase fixture)
             ─► revision with guide block ─► publish ─► package ─► glasses sync
glasses: CoachScreen (applet-renderer) ─► pure transitions (applet-runtime/coach.ts)
         ─► session.update ─► IndexedDB (before acknowledging) ─► state backup on Sync
question/problem ─► coach state "pending" ─► apps/glasses/src/coach.ts
         ─► POST /v1/coach/requests (device, idempotent) ─► coach_request job
         ─► worker: retrieval over the published revision + COACH_MODEL ─► checked result
         ─► glasses poll GET /v1/coach/requests/:id ─► applyResult (once)
```

- **Format** (runtime 0.4.0, all optional): per sequence step `source {page?,
  section?}`, `parts[]`, `warning`, `flag: ambiguous|unreadable` + `flagNote`; a
  top-level `guide {sequence, sourceTitle?, parts[], excerpts[]}` with verbatim
  manual text per step. Validation requires a source on every guide step and
  resolves every part/excerpt reference. The authoring prompt tells models to
  fill these and flag unclear content instead of guessing.
- **Fixture**: `packages/applet-format/src/fixtures/manuals/two-shelf-bookcase.md`
  (original, Apache-2.0) and its coach definition `fixtures/bookcase.ts`,
  including one unreadable and one ambiguous step. It's a bundled glasses
  example and what `fake:demo` returns for a bookcase/assembly manual.
- **Coach state** lives in `AppletState.coach` (completed steps, requests,
  answer, clarification, branch, history, applied result IDs), so it's saved
  locally with every action and backed up through the existing owner-scoped
  `PUT /v1/projects/:id/state`. Migration keeps it.
- **Read-only context** (`coachContext`, tool `coach_context`): current step,
  its parts, the manual's excerpts for it, progress and fix status. Nothing else.
  Meta AI doesn't get the manual or history beyond what a tool returns.
- **Grounding** (worker, `apps/worker/src/coach.ts`): keyword retrieval over step
  text and excerpts, a prompt with numbered passages, JSON output, then checks:
  answers must cite given passage IDs; fixes need 1–6 cited steps, a return step
  at or before the current one, and copy that fits. Anything else fails closed
  to "the manual doesn't say". `COACH_MODEL` defaults to the free `fake:coach`.
- **Idempotency and retries**: the glasses choose an operation ID per request;
  the API keys the job on `coach:<deviceId>:<operationId>`, so resending returns
  the same job. Results apply once (by request ID); late results for cancelled
  requests are ignored; a proposal never replaces an active fix. WebMCP calls
  return immediately and never wait on a model.

## Voice tools (prefix `j26_<toolPrefix>_`)

`next_step` / `previous_step` (follow an active fix first), `coach_context`
(read-only, `untrustedContentHint`), `repeat_step`, `show_parts`,
`complete_step`, `ask_question {question}`, `report_problem {problem}`,
`choose_option {option}`, `confirm_fix`, `cancel_fix`. Arguments are validated in
the executor (non-empty, ≤ 500 characters). Names are reserved in
`BUILTIN_TOOLS`.

## Evidence

| Layer | What ran | Result |
| --- | --- | --- |
| Unit (Node) | runtime coach transitions, local answers, output checks; worker handler with the fake model and a stub DB; format validation | Pass |
| Browser, dev stub + mocked API (Chrome 157, 600×600) | `apps/glasses/browser-tests/coach.spec.ts`: D-pad focus/Enter, More menu paging, parts, repeat, complete, local answers, no scroll, fit guard, reload persistence; offline → Retry with the same operation ID; reload while pending resumes polling without resubmitting; clarification; confirm → fix steps → return; decline; cancel a pending question | Pass |
| Desktop Chrome native WebMCP (`--enable-features=WebMCP`) | `webmcp-native.spec.ts` (opt-in `NATIVE_WEBMCP=1`): discovery via `getTools`, invocation via `executeTool`, unregister on leaving, re-register without duplicates | Pass |
| Production build, service worker | offline cold start → open coach → Next / Show parts → reload restores the step (one-off run) | Pass after the worker finished precaching |
| Real API + worker + PostgreSQL | not run: no local container VM | **Not verified** |
| Meta simulator extension, Meta AI, real model, glasses | not run | **Not verified** |

Finding: Chrome 157's `executeTool(tool, input)` requires an **object**;
Meta's agent-tools guide shows a JSON string. The native test accepts both.

## Limitations

- Retrieval is keyword-based over one manual; fine for a short guide, weak for
  synonyms. The fake model is extractive and only knows "backwards", "missing"
  and vague reports.
- Real-model quality and cost are untested (`COACH_MODEL` is opt-in).
- The phone authoring flow reuses `generate_revision`; diagram crops per step
  depend on the existing model pipeline and weren't exercised here.
- In the phone app's preview, local answers, menus and navigation work; questions
  that need the backend stay "checking" (the preview has no request runner).
- Pending-request polling runs only while the guide is open (by design: no
  background network on the glasses).
- Existing issue seen while testing: the **paired** home screen docks Older +
  Sync + Voice when there are more than three solutions, which trips the
  two-action guard and blanks the screen. Not changed here.

## Hardware checklist (minimal)

1. Record glasses firmware and Meta AI app versions; note Developer Mode state
   (Meta AI app → Developer Mode; restart glasses and app after toggling).
2. Serve the glasses build over **public HTTPS** (see "Testing on real glasses"
   in [apps.md](apps.md)); never expose `AUTH_MODE=dev` APIs publicly.
3. Install via deep link or App Connections, pair, publish the bookcase guide
   from the phone, Sync.
4. In the guide: band-only pass (D-pad focus visible at edges, each pinch acts
   once, More menu, parts, repeat, complete, Back returns to the library).
5. Voice: "Hey Meta, next step", "which screws do I need?", "I attached the left
   side backwards", "yes, use that fix". Count it verified **only** if the
   app logs an actual tool callback (Meta AI may answer from its own knowledge
   instead). Confirm tools disappear after leaving the guide.
6. Ask a question that needs the backend; check the answer appears with its page.
7. Offline: airplane mode, reopen the app from the grid, continue navigation and
   completion; start a question (shows "No connection"), restore network, Retry,
   confirm the same request completes once.
8. Close and reopen mid-fix: the fix and completed steps are still there.
