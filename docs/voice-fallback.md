# Voice fallback: always-listening bridge (contingency for WebMCP)

Status (2026-11-14): **V1 built and checked in the browser (Chrome at
600×600, not the simulator extension, not glasses).** Local API (dev auth) +
`fake:voice`, a published Row counter, paired glasses app with Voice on,
`scripts/voice/say.ts`: "add two rows" → 2, "set the rows to 12" → 12, chatter
→ `ignored`, each round trip about 50 ms with the fake model. The rest is still
plan. Why it exists: on our device
Meta AI never invokes WebMCP tools, including Meta's own sample
([audit](webmcp-audit.md#hardware-result-2026-11-14-registered-never-invoked)).
Goal: applets can be driven by voice alone, with or without Meta AI.

## Hard constraint and the way around it

Glasses web apps **cannot capture the microphone**. Meta's docs: "Only the
Device Access Toolkit can use the glasses' camera or capture microphone audio."
So listening must happen in a **phone app**, and commands must reach the glasses
web app over the network, through our API.

The glasses microphones are reachable from any phone app as a Bluetooth
headset. Meta's DAT guide "Microphones and speakers" says:

> In HFP mode, the wearable's microphones use beamforming to isolate the
> wearer's voice, which significantly reduces the volume of ambient sounds and
> other speakers.

That is the "focus on the wearer" processing we wanted, it runs on the glasses,
and it needs no experimental DAT approval: it's standard Android Bluetooth SCO.
Costs: HFP is mono voice quality (16 kHz or 8 kHz, negotiated), and while it's
active, glasses audio output drops from A2DP to HFP quality.
(Source: Meta docs MCP `search_dat_docs`, "microphone audio from glasses
Bluetooth HFP beamforming"; guide `/docs/develop/dat/microphones-and-speakers`.)

Rejected microphone paths:

- **DAT camera-stream audio** (PCM in-band with video) is *not* beamformed, so
  ambient noise comes through at natural levels. It also needs a camera stream
  and beta approval.
- **DAT `Speech`** does on-glasses transcription: free, low latency, dev/beta
  only. Our earlier "iOS background is best-effort" worry was about this
  feature (issue #360), not plain HFP recording. Docs say it "can stop after inactivity, a timeout, or another
  performance constraint", and iOS runs end after about a minute (SDK 1.0.x). Keep
  it as an optional text source (mode B below) and measure it, but don't depend
  on it.

## Architecture

```
 Glasses mics ──HFP (beamformed)──► Phone: Voice Bridge (iOS Swift / Android Kotlin plugin in apps/author)
                                      AudioRecord 16 kHz mono
                                      → noise suppression → VAD → utterance clips
                                      │  POST /v1/voice/utterances (audio or text)
                                      ▼
                                    API (apps/api)
                                      resolve: packages/model, VOICE_MODEL
                                      (audio + open applet's tools + state → one tool call or none)
                                      │  SSE  GET /v1/voice/events
                                      ▼
 Glasses web app (apps/glasses) ◄─────┘
   executes the tool with the same appletTools() executor WebMCP uses
   shows "heard: …" + result; PUT /v1/voice/context on applet/view change
```

**One action contract.** `appletTools(def, host)` in
[`packages/applet-renderer/src/webmcp.ts`](../packages/applet-renderer/src/webmcp.ts)
already builds name, description, scalar schema and `execute` for every action,
plus `read_state`, `open_view` and `next_step`/`previous_step`. The bridge sends
those same tool declarations to the model and runs the chosen tool's `execute`.
If WebMCP starts working, both paths hit the same dispatcher, and the runtime
still validates every argument.

## Components

### A. Phone: Voice Bridge (iPhone and Android)

**Both platforms are required.** The bridge is a **Capacitor plugin inside the
authoring app** (`apps/author`, already a Capacitor iOS/Android app). Users then
install one app, and it reuses the signed-in Clerk session, so no separate
pairing is needed. Capture, VAD and upload run **natively** (Swift / Kotlin),
not in the WebView, because WebView JS gets throttled or suspended in the
background. The TS side only starts and stops the bridge, shows its status, and
holds the mute toggle. The plugin interface (`start`, `stop`, `mute`, `status`
events) is the same on both platforms.

**Fast fallback for both platforms, no install: a phone web page.** A `/author/voice`
page uses `getUserMedia({ audio: { noiseSuppression, echoCancellation,
autoGainControl } })` + `@ricky0123/vad-web` (Silero in WASM) + the same upload
endpoint, with a Screen Wake Lock. Its limit: it works only while the page is
open and the screen is on. In iOS Safari, locking the phone stops the mic. It is
fine for a table demo, and V1.5 builds it first because it needs no Mac and no
app store. Whether Safari and Chrome pick the glasses' HFP mic over the
phone's own mic is **unverified**. Test it in the V0 spike.

**iOS (Swift, in the Capacitor plugin):**

- `Info.plist`: `UIBackgroundModes = audio` and `NSMicrophoneUsageDescription`.
  A Bluetooth usage string isn't needed for HFP, which goes through the system
  audio route, not CoreBluetooth.
- `AVAudioSession` `.playAndRecord`, mode `.voiceChat` (enables Apple's voice
  processing: echo cancellation, noise suppression, AGC), options
  `[.allowBluetoothHFP]`. Then `setPreferredInput` to the `.bluetoothHFP` port
  whose name matches the glasses (Meta's snippet in the DAT guide).
- `AVAudioEngine` input tap → resample to 16 kHz mono → Silero VAD
  (ONNX Runtime iOS, or a Core ML conversion) → WAV → `URLSession` upload. The
  process stays alive in the background while the engine is recording, so plain
  uploads work.
- **Must be started while the app is in the foreground.** iOS doesn't let a
  background app begin recording. After the first start, the user can lock the
  phone and pocket it. iOS shows the orange mic indicator, which is expected.
- Handle `AVAudioSession.interruptionNotification` (calls, Siri, other apps)
  and `routeChangeNotification` (glasses disconnect, HFP rate change). After an
  interruption ends with `.shouldResume`, restart the engine and reinstall the
  tap with the new input format (Meta's guide calls this out). If iOS refuses
  to resume while backgrounded, post a local notification: "Voice paused, tap
  to resume".
- Builds need **a Mac with Xcode**. A free Apple ID can sideload onto the
  team's own iPhone (the profile expires after 7 days). TestFlight or other
  phones need the $99 developer program. Capacitor's iOS project exists but
  has never been built.

**Android (Kotlin, in the Capacitor plugin):**

- **Foreground service** with `foregroundServiceType="microphone"`, started from
  a visible activity (Android 14+ requirement). Persistent notification with
  **Mute / Resume**. Survives screen-off.
- **Route:** `AudioManager.availableCommunicationDevices` → the
  `TYPE_BLUETOOTH_SCO` device that is the glasses → `MODE_IN_COMMUNICATION` +
  `setCommunicationDevice` (Meta's sample code). Watch route changes and
  re-acquire. If the glasses disconnect, fall back to the phone mic and say so in
  the notification.
- **Capture:** `AudioRecord` with `VOICE_COMMUNICATION` at 16 kHz mono PCM16
  (accept 8 kHz if that's what HFP negotiates, and report it). Attach
  `NoiseSuppressor` and `AutomaticGainControl` when `isAvailable()`. Optional
  later: RNNoise if field clips are still noisy.
- **Ignore silence: Silero VAD** (ONNX, ~2 MB, runs on 30 ms frames; e.g. the
  `android-vad` library, which also has WebRTC VAD as a lighter mode). The
  segmenter keeps a 300 ms pre-roll, closes after 500–700 ms of silence, drops
  clips under 300 ms, and force-splits at 8 s. Add an RMS floor so the VAD never
  fires on hiss. Nothing is sent while there's no speech.
- **Upload:** WAV (16 kHz × 2 B × 3 s ≈ 96 KB; fine on phone data). Opus later
  if needed. Each clip gets a UUID (for dedupe), a capture timestamp, and the
  sample rate.
- **Auth (both platforms):** the authoring app's Clerk user session. The
  native side gets a short-lived token from the TS side and refreshes it
  through a plugin callback. The glasses device token stays separate. The API
  matches the two by owner.
- **Mode B (experiment, both platforms; the DAT SDK exists for iOS and Android):** DAT `Speech` final transcripts are posted as
  `{ text }` instead of audio. It's cheaper and faster when it works, and it's
  the fallback if HFP misbehaves on Display glasses.

### B. API (`apps/api`, new `routes/voice.ts`)

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `PUT /v1/voice/context` | glasses | Open applet id, view, tool declarations (no `execute`), `describeState` snapshot. Replaces the previous one; TTL about 10 min. |
| `GET /v1/voice/events` | glasses | SSE stream of `{ id, tool, args, heard }` commands and `{ id, ignored, heard }` notices. |
| `POST /v1/voice/utterances` | bridge | `audio/wav` body or `{ text }`. Returns `202 { id, outcome }`. |

Resolver: one `packages/model` call with **audio input + tools**. The system
prompt is short. It lists the tools and state, says "call exactly one tool, or
call `none` if the speech isn't a request for this applet", and gives
`tool_choice` required. The model returns `heard` (a short transcript) for the
UI. The model is configurable with `VOICE_MODEL` (default chosen by the bench
below). `fake:` gives a deterministic resolver for tests.

- `packages/model` needs a new `Part` `{ type: 'audio', format: 'wav', data }`
  mapped to OpenRouter's `input_audio` content part, and an `audio` capability
  flag. This is the only model-layer change.
- Drop an utterance if no glasses are subscribed, if there's no context, or if
  it's older than 8 s when resolved. Dedupe by clip id.
- **Never log or store audio or transcripts** (AGENTS rules). Log only the id,
  durations, model, latency, outcome and cost.
- Fan-out: the event bus is in-process. If the API ever runs more than one
  instance, switch to Postgres `LISTEN/NOTIFY` (we already have the database).
- Owner scoping: the bridge and the glasses must belong to the same user. Every
  lookup filters by owner.

Update `docs/api.md` in the same change.

### C. Glasses (`apps/glasses`)

- A **Voice bridge** toggle in settings, off by default. Turning it on opens
  the SSE. This is an explicit opt-in exception to sync.ts's "network only on
  explicit actions" rule, so document it there.
- On applet open, view change and committed action: `PUT /v1/voice/context`,
  debounced and built from `appletTools()`.
- On command: look up the tool by name in the *current* `appletTools()` list.
  If it's missing, the context is stale: show "not available here". Otherwise
  `execute(args)`. Show a bright one-line chip with what was heard and the
  result (additive display: emitted light, no scrim), auto-hidden after about
  3 s.
- Close the SSE on `hidden`/pause and reopen on `visible` (platform rule).
  Commands that arrive while hidden are dropped server-side by the 8 s staleness
  rule.
- Spoken confirmation: `speechSynthesis` exists on the glasses. **Off in v1**:
  the open mic would hear it. Turn it on only after the echo test (below).

## Silence, noise and false triggers (defence in depth)

| Layer | Stops |
| --- | --- |
| HFP beamforming (glasses DSP) | Other people, ambient noise |
| `NoiseSuppressor`/AGC (phone) | Steady noise, level swings |
| RMS floor + Silero VAD + min length | Silence, clicks, breathing |
| Model `none` decision | Conversation not meant for the applet |
| Tool must exist in current context + runtime arg validation | Stale or invalid actions |
| Visible chip + undo-able actions | Recovery from a wrong action |

No wake word in v1, as requested ("listens the whole time and just immediately
does the thing"). If false triggers are bad in the field, add a cheap optional
gate: a spoken prefix ("applet, …") enforced by the prompt, or the band button
held as push-to-talk. Both can be added without changing the architecture.

## Latency and cost (estimates, to measure)

- End of speech to action: VAD hangover 0.5–0.7 s + upload ≈0.1–0.3 s + model
  ≈0.6–1.2 s + SSE ≈0.15 s ≈ **1.5–2.5 s**.
- Cost: audio-capable models with tool support on OpenRouter, checked
  2026-11-14 via the public `/api/v1/models`: `google/gemini-3.5-flash-lite`
  ($0.30/M), `google/gemini-3.1-flash-lite` ($0.25/M text, $0.50/M audio),
  `qwen/qwen3.8-omni-flash`, `google/gemini-3.8-flash`. With about 1–2 k tokens
  of context per clip, that's roughly **$0.0005 per utterance**. A noisy hour
  with ~300 VAD clips is on the order of $0.15.

## Unknowns to settle on the device first (day-1 spike)

1. Does holding an HFP/SCO link to **Display** glasses keep our web app in the
   foreground, or does it show call UI or pause it? *Biggest risk.*
2. Does an open SCO link disable "Hey Meta" or the band? (Acceptable if so, but
   record it.)
3. Negotiated rate: 16 kHz or 8 kHz. Is beamformed speech clean enough at
   arm's length from a talking neighbour?
4. Glasses and phone battery over 1 h of continuous SCO.
5. Mode B: can a DAT `Speech` session run while our web app is in front? How
   long does it last before it stops?
6. **iPhone:** repeat 1–4 with the glasses paired to an iPhone. Also check that
   recording continues for 30 min with the phone locked in a pocket, that it
   resumes after a phone call and after Siri, and whether the iPhone's own mic
   ever silently takes over from the glasses' mic.
7. Phone web page (both OSes): does `getUserMedia` get the glasses' HFP mic,
   and does Wake Lock hold for 30 min?

Record results in this file with firmware and app versions, like the audit.
Don't claim device behavior that wasn't observed on the device.

## Milestones

- **V0 spike (≈2 h, glasses + whichever phones we have):** the quickest check is
  the phone web page recording VAD clips while the glasses web app is open.
  It runs on iPhone and Android with no install. It answers unknowns 1–3 and 7
  and gives us the clip set for the bench. Native HFP checks (4, 6) follow V3.
- **V1 end-to-end without a phone (no spend) — done:** API voice routes with the
  `fake:` resolver, glasses SSE client and chip, and `scripts/voice/say.ts "add
  two rows"` posting text as a stand-in bridge. Verified in the Chrome
  simulator.
- **V1.5 phone web page (both OSes):** `/author/voice` with browser VAD and
  upload. This is the first real voice demo, with the screen on and the page
  open.
- **V2 model bench (small real spend, approval first):** run the V0 clips plus
  10 non-command chatter clips through 3–4 OpenRouter audio models. Score
  correct tool + args, correct `none`, and p50/p90 latency. Pick `VOICE_MODEL`.
- **V3 native bridge plugin (iOS and Android in parallel):** the Capacitor
  plugin with background capture, mute, route and interruption recovery,
  phone-mic fallback, and upload. The iOS half needs a Mac. Then field test on
  both phones.
- **V4 (optional):** echo-safe spoken confirmations, push-to-talk or prefix
  gate, DAT Speech mode B.

### Browser preview

The authoring preview also offers hold-to-talk and a text fallback in the browser. It sends the preview's current context to `POST /v1/voice/resolve` and executes a returned tool locally in the preview; it does not require paired glasses or Meta AI.
