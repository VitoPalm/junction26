# Glasses platform reference (Meta Ray-Ban Display web apps)

Verified against Meta's official docs on 2026-11-14 (docs index reports
"Documentation version: v1.0"; pages carry no dates). Re-check before relying on
anything marked *unverified*. Primary sources:

- Docs index for agents: <https://wearables.developer.meta.com/llms.txt>
  (append `?product=all&version=1.0&document=products/webapps/sections/guides/setup`,
  `.../agent-tools`, `.../troubleshoot`, `.../acceptable-use` for the guides)
- Agent skills repo: <https://github.com/meta/meta-wearables-webapp>
  (`plugins/meta-wearables-webapp/skills/ai-glasses-webapp-*/SKILL.md`)
- UI toolkit source: <https://github.com/meta/meta-ray-ban-display-ui-toolkit-web>
- Meta docs MCP server: `https://mcp.developer.meta.com/wearables` (`search_webapps_docs` tool)
- Simulator: Chrome Web Store extension "Meta Ray-Ban Display Simulator",
  ID `jpjlmmodokemlepklkdbimceggpbjcll`

## Hardware and runtime envelope

| Property | Value |
| --- | --- |
| Devices | Web apps run **only on Meta Ray-Ban Display** glasses |
| Minimum versions | Glasses software v125+, Meta AI phone app v272+ |
| Viewport | **600×600** CSS px, **DPR 1**. Lay out responsively, never hardcode |
| Refresh | 30 Hz, so the frame budget is 33 ms. No 60 fps loops |
| Network | ~500 Kbps down, ~150 ms RTT ("1 KB ≈ 16 ms") |
| CPU | ~12× slower than a modern laptop core |
| Memory | Heap under 128 MB |
| Display | **Additive**: black is transparent, light is added to the world |

Performance budgets from Meta's optimize skill:

- First paint under 1 s.
- Usable content under 5 s.
- First-load transfer **under 300 KB**.
- **Warm launch under 2 s with 0 bytes transferred.**
- Fewer than 15 initial requests.

Our current demo shell is about 196 KB gzipped (JS 178 KB + CSS 18 KB). Applet
diagrams are extra and arrive in the applet package.

## Additive display

The lens, and the simulator via `mix-blend-mode: screen`, **adds** our pixels'
light to the real world. Consequences that are easy to get wrong:

- Black and dark colors are invisible. Dark "plates", scrims, `backdrop-filter`
  blur and translucent panels **cannot darken or blur the world** behind the
  lens. They only add a grey veil that lowers our own contrast. (Codex tried
  this on 2026-11-14; it made things worse and was removed.)
- Readability comes only from **emitted light**: white or high-luminance colors,
  heavy weights, large sizes, thick strokes. Blue is dim; use light accents
  (`--g-ink-accent: #8fdcff`).
- Thin line art vanishes once downscaled. Our `Diagram` component re-renders
  every source image for its display size (thicken, crop, de-speck, brighten).
  See `packages/glasses-ui/src/lib/ink.ts`.
- Use `var(--uit-color-background-window)` for the window background.
- Judge readability in the simulator with **background blur 0** on bright scenes
  (bridge, station) and on the busy cafe scene. The sim's per-scene brightness
  is cafe 61%, bridge 68%, station 70%.

## Input

- **D-pad focus navigation** from the Neural Band (or arrow keys in the sim).
  **Pinch / Enter activates the focused control's `onClick`.** Give each control
  one `onClick` only; don't add separate activation handlers.
- Drag: `touch-action: none` on `body`, Pointer Events with capture, cancel on
  hide and unmount. Pointer Lock is unsupported.
- Text: `<input>`/`<textarea>` open the handwriting/voice composer only after
  the wearer focuses and activates them. Programmatic focus doesn't open it.
  Read values from `input` and `change` events.
- Sensors: `DeviceMotionEvent.requestPermission()` /
  `DeviceOrientationEvent.requestPermission()` from a user action;
  `navigator.geolocation.watchPosition()`.

## What web apps cannot do

- **No camera, no microphone capture.** Only the native Device Access Toolkit
  (iOS/Android companion apps) can do that.
- Spoken input reaches a web app only as dictated text in a field, or as WebMCP
  tool calls from Meta AI. A phone app can capture the glasses mics over
  Bluetooth HFP, which Meta's DAT docs say is **beamformed to the wearer's
  voice**. Our fallback relays that through the API: [voice-fallback.md](voice-fallback.md).
- No guaranteed execution while hidden: stop timers, animation frames, sensors,
  polling and sockets on pause, hide, route exit and unmount.

## WebMCP ("Hey Meta" voice → our actions)

Status: Meta's [public FAQ](https://developers.meta.com/wearables/faq/) labels
WebMCP **developer preview**. The agent-tools guide describes the API surface as
implemented and stable while tracking W3C draft revisions; that does not verify
availability or invocation on our device/account. See [the WebMCP audit](webmcp-audit.md)
for open invocation reports and the distinction between local registration and
actual Meta AI callbacks. **Off by default, enabled per device** by
Developer Mode or by Meta's rollout. After toggling Developer Mode you may need
to restart both the glasses and the Meta AI app. Eligibility is decided once at
app launch; relaunch the app after enabling.

```ts
// Feature-detect. The runtime installs document.modelContext before page scripts.
// Never ship a WebMCP polyfill (a test-only stub is fine).
if (document.modelContext) registerAppletTools();

// Illustrative lifecycle: one owner per open applet; clean up on leaving it.
// Keep registrations across view transitions. Product adapter:
// packages/applet-renderer/src/webmcp.ts; apps/glasses owns its lifetime.
useEffect(() => {
  const ac = new AbortController();
  try {
    const r = document.modelContext?.registerTool({
      name: 'j26_counter_increment',            // appprefix_verb_noun
      description: 'Add to the row counter of the open crochet guide.',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'integer', description: 'How many rows to add (default 1).' } },
        required: [],
      },
      annotations: { readOnlyHint: false },
      async execute(input, { signal }) {
        const result = runtime.dispatch('counter.increment', { amount: Number(input.amount ?? 1) });
        return result.ok
          ? { ok: true, rows: result.state.rows, next_action: 'Tell the user the new row count.' }
          : { error: result.code, message: result.message, next_action: 'Explain the problem briefly.' };
      },
    }, { signal: ac.signal });
    // Return value varies by build (promise / handle / undefined): don't chain .catch blindly.
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, reportRegistrationError);
  } catch (e) { reportRegistrationError(e); }      // missing/mistyped members throw TypeError synchronously
  return () => ac.abort();
}, [appletId]);
```

Contract details that constrain our applet format:

- **Only scalar parameters reach the assistant**: `string`, `number`, `integer`,
  `boolean`. `array`/`object` arrive as JSON strings. Only top-level `type`,
  `description` and `required` are read. `enum`, `minimum`, `maximum`, `items`,
  `default` and nested schemas are **dropped and not enforced**. Validate
  everything in our executor.
- Name: 1–128 chars `[A-Za-z0-9_.-]`, but only **57 characters** remain after
  Meta's prefix, and names sharing their first 57 characters collide. Tool
  description ≤1024 chars, parameter description ≤256.
- Reserved names (silently rejected): `openUrl`, `goBack`, `goForward`,
  `reload`, `getCurrentUrl`, `getPageTitle`, `getPageText`.
- Duplicate name: rejects with `InvalidStateError` and does **not** replace the
  existing tool. Unregister (abort) before re-registering.
- `execute(input, { signal })` has a **10 s deadline**; late results are ignored.
- Return a plain object or string. It is JSON-stringified, so fields like
  `next_action` reach Meta AI. `isError` is dropped, so return
  `{ error, message, next_action }` for handled failures. Throw only for
  unrecoverable cases and cancellation.
- **Speech ends the assistant's turn**: "say X, then call Y" never reaches Y.
- Annotations: `readOnlyHint`, `untrustedContentHint` (both default false).
  `title` isn't sent to Meta AI.
- `getTools()` lists this document's tools; a `toolchange` event fires on change.
- Tools work only while the app is in front of the user. Tool-calling turns are
  "substantially slower" than plain turns. No cross-app composition.
- **Connectivity:** Meta AI needs the network. A cached applet works offline
  with the band; "Hey Meta" control does not promise offline operation.

## Getting a web app onto the glasses

1. **Host on a public HTTPS URL** with a valid certificate. HTTP isn't supported.
   Any host works (Meta's skill uses Vercel; we use Aiven Runtime).
2. **Enable Developer Mode** in the Meta AI phone app: Settings → App Info → tap
   the App version number 5 times → Enable. It persists. If Web Apps are
   missing: check country availability and that the account has a date of birth
   (test accounts often lack one).
3. **Add the app**, either way ends in an on-glasses confirmation:
   - **QR code** encoding `fb-viewapp://web_app_deep_link?appName=<name>&appUrl=<https-url>`
     (the simulator's "View on Glasses QR" generates it). Unreviewed apps show
     as "unverified".
   - Manually: Meta AI app → Devices → Display Glasses settings → App
     connections → Web apps → Add a web app (name + URL).
   - From a page already open on the glasses: `navigator.install(url?, { name })`.
     A resolved promise means "accepted for launch", not installed.
4. HTML basics: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
   `<meta name="application-name" content="...">`, a meaningful description.
   **Use a PNG favicon larger than 52×52; SVG favicons aren't supported.** The
   build skill also mentions `<meta name="mrbd-web-app-capable" content="yes">`
   (unconfirmed by the official guide; harmless to include).
5. Updates: keep the same URL. If a new deploy behaves like the old one, reload
   the app from its universal menu.

Distribution: Meta says it "review[s] apps before publication"; the submission
process isn't publicly documented. For the hackathon, devices in Developer Mode
install by URL/QR. See the acceptable use policy at
<https://wearables.developer.meta.com/acceptable-use-policy>.

## Offline and storage

Meta documents offline support (service workers, Cache API) in general terms
but publishes **no quota, eviction or IndexedDB guarantees** for the glasses.
Its troubleshooting guide says to "handle unavailable or evicted cached data"
and to "test one successful online load before testing offline behavior".

Our approach (verify on hardware):

- Service worker + Cache API: app shell (versioned, precached).
- IndexedDB: applet packages (by release hash), user state, outbox for backups.
- `localStorage`: tiny preferences only.
- `navigator.storage.estimate()` / `persist()` where available. Always keep a
  recovery path through cloud backup.

## UI toolkit

- Packages: `@wearables-ui-toolkit/mrbd` (components, focus, page transitions),
  `@wearables-ui-toolkit/icons`, `@wearables-ui-toolkit/androidx-shapes`.
  **130.33.0 is the latest as of 2026-11-14.** Peer deps: `react`/`react-dom`
  `^19.2.7`, `react-router-dom ^7.17.0`, optional `next ^15 || ^16`. Don't use the
  legacy `@meta/wearables-ui-toolkit-*` scope.
- Typography classes `uit-text-*`: heading1 40/700, heading2 36/700, body1
  32/400, body1-emphasized 32/700, body2 28, label 24, numeral2 64/500.
- Colors: `--uit-color-text-primary #fff`, `secondary #cfd3d9`, `accent #2694fe`
  (too dim on additive; we override).
- Buttons scale to ~0.82 when unfocused; `ButtonGroup` docks actions.
- Meta's scaffold skill (React + Vite + TS):
  `node <skill>/scripts/init-webapp.mjs <dir>`, `install-ui-toolkit.mjs`,
  `validate-ui-toolkit.mjs` (structure validator; **its scroll-oriented skeleton
  rules don't match our no-scroll policy**, so our own fit tests are the
  acceptance gate).
- Simulator: 600×600 surface, additive blend, scenes, webcam background, D-pad
  shortcuts (arrows / Enter / Esc), recording, QR, QA test, perf score, and
  "Test with Agent". Live agent-tools docs describe desktop WebMCP enumeration,
  invocation and a tool-response chat log with WebMCP enabled in Chrome; the
  available extension/browser combination still needs checking. Desktop checks
  do not verify glasses-side voice routing or spatial AR. See [audit](webmcp-audit.md).

## Native alternative (not the plan of record)

The **Device Access Toolkit** (`meta-wearables-dat-android`, `meta-wearables-dat-ios`)
runs on the phone and sends component trees to the display
(`display.send(...)` replaces the view), plus on-device speech (`MWDATSpeech`,
experimental), Inputs and voice invocation ("Hey Meta, start <app>", needs
approval). It was rejected for now because iOS locked/background speech is
best-effort (a maintainer said so in issue #360, and runs end after ~1 min in
SDK 1.0.x). An Android Camera sample builds in the owner's scratch project
(`~/.t3/scratch/2026-11-13-can-you-set-up-the-08528f2a`, `./build-camera.sh`
with Java 21, Developer Mode, no app credentials). Keep the applet format
renderer-agnostic so a native renderer remains possible.
