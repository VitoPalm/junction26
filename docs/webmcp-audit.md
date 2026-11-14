# Meta WebMCP assumption audit

Research date: 2026-11-14. Documentation and source inspection only; no glasses
available and no desktop WebMCP execution performed in this audit.
Freshness recheck: 2026-11-14 against project baseline `e76b1c8`, current Meta
FAQ, live documentation MCP, repository heads and issue metadata. The pinned
Meta source revisions below remain the repository heads; issues #31 and #35
remain open with zero comments.

## Conclusion

WebMCP is a documented Meta integration with official samples. It is a reasonable
adapter for applet actions, but our project has not established reliable voice
invocation on a target device/account. Continue the runtime and band-operated
product while keeping this dependency explicit. A later Scoreboard retry on
2026-11-14 produced one confirmed on-device read-tool callback (see below);
reliable action invocation remains unverified. The owner clarified that glasses are for operating applets;
creation and definition edits happen in external authoring surfaces.

Meta's public FAQ labels WebMCP **developer preview**. The detailed agent-tools
guide calls the API surface implemented and stable while warning that it follows
the evolving W3C draft. These statements concern different things: the API
contract can exist while availability and end-to-end behavior remain uncertain.
[Meta FAQ](https://developers.meta.com/wearables/faq/),
[agent-tools guide](https://wearables.developer.meta.com/docs/develop/webapps/agent-tools).

## Evidence and access

The Developer Center page and `llms.txt` returned a login page to web fetch.
However, the official public documentation MCP server worked without credentials:
`https://mcp.developer.meta.com/wearables`. Called `tools/list` and
`search_webapps_docs`; read the returned Availability, Overview, How it works,
Limitations, On desktop, Listing your tools, Reserved tool names, Speech ends
the turn, and simulator-preview sections. The toolkit README documents this
public search service. Reproduce with queries such as “WebMCP agent tools
availability developer preview Developer Mode rollout foreground simulator” and
“WebMCP modelContext registerTool inputSchema execution timeout return values”.
[Toolkit README](https://github.com/meta/meta-wearables-webapp/blob/fbf132997d036548ce090761a8bd4cf0afbda52a/README.md).

Public source revisions inspected:

- Toolkit: `fbf132997d036548ce090761a8bd4cf0afbda52a`.
- Agentic samples: `f4f50ac0d1028a7530b88168b271a0dc9613a0bf`.

No account was linked, no code was deployed, and no paid model was invoked.

## What the documented mechanism establishes

The active page registers callbacks on `document.modelContext`. Meta AI chooses
whether a spoken request matches one, executes it in that page, and receives its
result. Tools apply only to the foreground app; there is no background or
cross-app composition. Eligibility is checked at app launch, with WebMCP enabled
per device through Developer Mode or rollout. All tool actions must have a
manual UI path. Calls have a ten-second deadline, and tool turns add latency.

The guide describes desktop Chrome with WebMCP enabled, tool enumeration and
`executeTool(tool, JSON.stringify(args))`; the simulator can expose tool responses
in a chat log. This supports desktop development, not proof of a particular
account's on-device voice routing. The returned `getTools()` list is local to
the document. [Agent-tools guide](https://wearables.developer.meta.com/docs/develop/webapps/agent-tools),
retrieved through Meta's public docs MCP.

Our current runtime architecture fits this model: voice and band should call the
same deterministic action dispatcher. A remote MCP authoring server for Claude
or ChatGPT is a separate integration; registering page tools does not connect
those assistants to Meta AI or import their conversations.

## Current implementation, inspected after the MVP landed

[`packages/applet-renderer/src/webmcp.ts`](../packages/applet-renderer/src/webmcp.ts)
now builds action tools and read-state/navigation tools, and guards each
registration against synchronous errors and differing return shapes. The glasses
app registers once per open applet to avoid duplicate names during overlapping
route transitions; cleanup aborts the registrations. This supersedes the earlier
implementation-plan suggestion to re-register on every screen.

[`session.ts`](../packages/applet-renderer/src/session.ts) serializes state
changes and persists them before acknowledging actions. Development `?webmcp`
installs a stub only in a dev build and only if the native surface is absent.
[apps.md](apps.md) records browser/emulator testing through the stub, not Meta
AI. Those recorded checks were not rerun in this documentation refresh.

Code-inspected limitations still to verify: the registration helper's count is
of calls that did not throw synchronously, not confirmed asynchronous acceptance
or assistant discovery; the read-state result describes field values rather
than original source documents; action callbacks do not currently consume the
host cancellation signal. Stub success must not be presented as device success.

## Hardware result, 2026-11-14: registered, never invoked

First test on the team's own Meta Ray-Ban Display. Glasses release
130.0.1.241.221, Meta AI app 298.0.0.28.160, English (US), Developer Mode on.
Both the glasses and the phone app were restarted before the tests.

1. **Official Agentic Todo sample** (`meta.github.io/meta_glasses_webmcp/examples/todo/`,
   installed by deep-link QR): Meta AI answered as if no app tools existed. No
   list change for "add buy milk to my list" and similar phrases.
2. **Minimal self-reporting probe** (three tools: `probe_add_points`,
   `probe_read_score`, `probe_ping`; it posts events to a log endpoint the
   developer can watch). Observed on the device:
   - User agent: Android 16 WebView (`Greatwhite` build), Chrome 154.0.8037.92, viewport 600×600.
   - `document.modelContext` present; `navigator.modelContext` absent. The
     object's members are `registerTool`, `getTools`, `executeTool`,
     `ontoolchange`, the `EventTarget` methods and an undocumented `when`.
   - All three `registerTool` calls returned promises that resolved within
     about 50 ms of page start. Each fired `toolchange`, and `getTools()` listed
     all three names.
   - A Neural Band select on the probe's button raised the score from 0 to 1
     and was logged, so the manual path and the logging worked in the same session.
   - **Zero `execute` callbacks** across repeated voice attempts with the probe
     in the foreground. The score didn't change.
   - The page went `hidden` for about 13 s during one attempt, then `visible`
     again. Unconfirmed whether the Meta AI overlay hides the web app while
     it handles a request.

This reproduces issues #31 and #35 on a newer release (v130) and in another
locale (en-US). Our page-side contract (feature detection, early registration,
schema, names) matches what the device accepts. The gap is between local
registration and Meta AI choosing a tool, which we can't diagnose from the page.
At that point voice control was **unverified/blocked**. The later retry below
supersedes the blanket invocation-blocked conclusion. Band operation is unaffected.

### Later retry, 2026-11-14: first confirmed voice callback

The owner reported that Meta repeatedly failed to recognize the word “probe”.
Renamed the diagnostic to Scoreboard v2, renamed all three tools to
`scoreboard_*`, and changed descriptions/example phrases to “add five points”,
“what's my score” and “check the scoreboard”. Relaunched on the glasses.

At **15:38:06 UTC**, session `n3kdvh` logged an actual `execute` callback for
`scoreboard_read_score` with `{}` arguments. A preceding band click set the
score to 2; the following heartbeat reported one tool call and score 2. The
owner independently reported that the voice interaction worked. This is
on-device invocation evidence, not just registration or a browser stub.

Only the read tool is confirmed in this observation. The exact spoken phrase
and Meta's spoken answer were not captured by the page. Renaming, simpler
phrasing and relaunch happened together, so the cause of success is not isolated.
The earlier claim that the failure was necessarily on Meta's side was too
strong. Next checks: a voice write with a specified amount, a correct readback,
and repeated calls across an app relaunch.

### Actual Applets app: owner-confirmed success, 2026-11-14

After the Scoreboard callback, the owner installed the current built glasses
app through a device-only HTTPS gateway and reported “it works”. The suggested
test was Brakka the Bold with “take five damage”, “how much health do I have”
and “heal three points”. This is owner-reported hardware success in the actual
app; the exact commands attempted, resulting values and individual callbacks
were not captured in this confirmation. Do not count all three suggested
commands as individually verified or infer broad reliability from this session.

## Registration success is insufficient evidence

Two open reports in the official repository describe the failure we most need
to distinguish from our own implementation bugs:

- [Issue #31](https://github.com/meta/meta-wearables-webapp/issues/31), opened
  2026-10-16: reporter describes MRBD v129, German interaction, successful local
  registration/enumeration, and no callback invocations. They also report local
  assistant-channel errors, explicitly without claiming those prove causation.
- [Issue #35](https://github.com/meta/meta-wearables-webapp/issues/35), opened
  2026-10-25: another reporter describes v129, Developer Mode, English interaction
  in the Netherlands, successful registration, and no invocation, also with the
  official Magic Ball sample.

Both had zero issue comments when checked through GitHub. These are first-hand
developer reports, not confirmed Meta diagnoses. They establish a reported
failure mode; they do not establish that region, language, Android, or v129 is
the cause, nor that all devices fail. Do not promise a locale change fixes it.

## Product assumptions requiring additional work

**Existing applet actions are the scope.** “Increase health by four” or “set
the row counter to twelve” maps to a declared runtime action. On-glasses
generation, layout editing and new capability requests are outside the current
scope, so generation latency is not a WebMCP blocker for this product. Focus
verification on selecting the right action, validating arguments, committing
state once and returning the actual result within the callback deadline.

**Source-aware explanations.** “Explain this step” requires a read tool exposing
the relevant step/source context, or our own retrieval/answer flow. Do not assume
Meta AI has the uploaded PDF, original author's conversation, or all local state.
Expose a small read-only snapshot with the current applet, view, available
actions and relevant values. Keep private/source content out of descriptions
unless intentionally needed by the assistant.

**Interaction boundaries.** We have no evidence for continuously listening
without wake words or invoking page tools while another app is open. Test the
intended explicit “Hey Meta” commands with the applet in the foreground.

## Adapter details to preserve

Meta's WebMCP skill advises scalar arguments, local validation, short distinct
tool names, safe per-tool registration, lifecycle cleanup, and explicit results.
It warns that schema constraints are discarded, names can collide after 57
characters, speech ends a turn, and `isError` is not a reliable failure channel.
The current skill remains a useful compatibility reference alongside the live
guide. [Pinned skill](https://github.com/meta/meta-wearables-webapp/blob/fbf132997d036548ce090761a8bd4cf0afbda52a/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-webmcp/SKILL.md).

Official samples are examples, not an executable device contract. In particular,
the Todo sample's local dispatcher returns `isError` failure objects, and its
README says most writes return only an acknowledgement; those differ from the
skill's recommendations. Its local `getTools()` is also a wrapper-owned registry,
not an acknowledgement from Meta AI. Inspect the distinction before copying its
test helpers. [Sample wrapper](https://github.com/meta/meta_glasses_webmcp/blob/f4f50ac0d1028a7530b88168b271a0dc9613a0bf/examples/todo/src/webmcp.ts),
[Todo README](https://github.com/meta/meta_glasses_webmcp/blob/f4f50ac0d1028a7530b88168b271a0dc9613a0bf/examples/todo/README.md).

## Useful verification without glasses

1. Contract-test the adapter with missing APIs, synchronous throws, promise and
   non-promise registration returns, malformed arguments, duplicate names and
   cleanup. Failure to register one tool must leave other tools and the UI usable.
2. Exercise native desktop WebMCP discovery and invocation when available;
   record browser version/flags and simulator version. A stub-only pass must be
   labelled as such. Check post-mutation rendering and persistence, plus tool
   changes when switching applets and views.
3. Keep a minimal read-state and increment fixture ready for eventual hardware
   testing, with visible callback-entry count and short technical status codes.
   Separate API presence, local enumeration, actual assistant callback, committed
   state and spoken result. Do not log transcripts, source content or secrets.
4. On hardware, first try an official sample and the minimal fixture, then our
   full app. Record firmware, phone/app versions, language, region, restart state
   and foreground visibility. Test removal/re-registration, failure responses,
   retries and offline band operation. Only observed callbacks establish routing.

Meta's deterministic browser checks are useful regression checks but do not
prove the device link or startup performance. The project can advance through
desktop acceptance while hardware acceptance stays pending.
[Meta testing guidance](https://github.com/meta/meta-wearables-webapp/blob/fbf132997d036548ce090761a8bd4cf0afbda52a/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-test/SKILL.md).

Questions for Meta when hardware/mentors become available: what identifies
assistant-side receipt of tools; whether the reported invocation failures have
a supported diagnosis; the intended simulator agent availability/setup; and
which device/account/locale combinations are currently supported. No messages
or issue comments were sent as part of this audit.
