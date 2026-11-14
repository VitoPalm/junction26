# Voice notes on applet pages

Status (2026-11-14): **M1 built, plus a web version of the phone recorder.**
Checked in headless Chrome only: the glasses app at 600×600 (WebMCP stub and
band clicks), the authoring app at phone size, and the real recorder code
against Chrome's fake microphone fed with a spoken WAV. **Nothing has been
tried on the glasses or a phone yet**, and no real (paid) model has been run;
every model call in these checks was a free `fake:` one. Owner decisions are
recorded below. The native background recorder (M2/M3) is not built.

### What exists now

- Format: any view may set `voiceNote: { label? }` (runtime 0.3.0). The
  authoring prompt and capability catalog explain it.
- Glasses: `VoiceNoteBar` (Record note / Stop note button, one hint line,
  "N on phone" as the button subtitle), WebMCP `j26_<prefix>_start_voice_note`
  and `…_stop_voice_note`, `apps/glasses/src/notes.ts`. Notes on guides belong
  to the step showing at start.
- API `/v1/notes/*` ([api.md](api.md#voice-notes)), table `voice_notes`
  ([database.md](database.md)), job `transcribe_voice_note`
  ([jobs.md](jobs.md)). Voice-bridge commands pause while a note records.
- Phone (authoring app, web and inside the Capacitor shells): Recorder screen
  (`#/recorder`), a status pill on every screen, and a Notes tab per applet
  (grouped by page, playback, transcript, edit, transcribe again, delete).
  `src/recorder.ts` records 16 kHz mono with 300 ms pre-roll, listens for the
  stop phrase, trims it, queues uploads in IndexedDB until the server confirms.
- Stop phrase detection, in order: the platform speech recogniser (Web Speech
  API: free to us; on-device or the OS vendor's service, depending on the
  phone); if it errors, or hears nothing for 6 s while the wearer clearly
  talks, the cloud check (`/v1/notes/:id/live`, a 5 s window sent only right
  after speech followed by a 300 ms pause). Band, "Hey Meta, stop the note"
  and the time limit always work.
- `scripts/voice/recorder.ts` stands in for the phone during development.

### Known limits of the web recorder

- A web page can't record in the background: the app must stay open with
  the screen on (Wake Lock is requested). Locking the phone ends the note
  with whatever was recorded (`interrupted`).
- Unverified: whether the browser picks the glasses' Bluetooth mic, and
  whether speech recognition and recording can share the mic (Android
  Chrome's recogniser may take the mic; the 6 s watchdog then switches to the
  cloud check). Headless Chrome's recogniser gets no audio at all.
- Trimming uses the pause before the phrase (or 1.6 s back without one); on a
  spoken test clip it cut inside that pause. The cloud check returns the
  phrase start directly. The final transcription removes the command again.

## What it is

A **voice note component** that the authoring model can place on an applet
page. On the glasses: "Hey Meta, record a note" starts recording, you talk,
and "stop recording meta" stops it. The phone records the audio from the
glasses mics, transcribes it properly in the background, and shows the note on
that applet page in the phone/web app with audio and transcript.

Owner decisions:

- **Meta AI triggers the recording through WebMCP.** Meta AI isn't the
  recorder. Recording runs on our phone bridge (iOS and Android).
- **Stop phrase: "stop recording meta".** Our live transcription detects it;
  Meta AI isn't involved. The live transcript is thrown away. It only exists
  to catch the phrase, so it should be as cheap as possible (on-device first).
- **Final transcript:** the full recording goes to a decent but cheap cloud
  model, asynchronously. Good transcripts on the phone are the goal.
- **Audio is kept** (playable and deletable on the phone).
- **English only** for now. More languages later.
- **Glasses never show old notes.** Each time a page opens, the component is
  empty, apart from a hint "N notes on your phone". You can record again on the
  same page any time. Old notes are never replaced or deleted by a new one.

## Why the phone records

Glasses web apps cannot capture the microphone (Meta docs; see
[glasses-platform.md](glasses-platform.md)), and a WebMCP tool call carries
arguments, not audio. The glasses mics reach the phone as a Bluetooth HFP
headset with on-glasses beamforming, which is the same path as the
[voice bridge](voice-fallback.md). Voice notes reuse that bridge: the same
Capacitor plugin in `apps/author`, the same HFP route handling, and the same
Clerk session.

## Flow

```
 "Hey Meta, record a note"
   │ Meta AI → WebMCP start_voice_note
   ▼
 Glasses (apps/glasses)
   note id (UUID) + project/release/view/component + state snapshot
   POST /v1/notes  ───────────────►  API: insert note (status recording)
   UI: ● REC 0:12 + "Say: stop recording meta"     │ push start event
                                                    ▼
                               Phone bridge (Swift / Kotlin)
                                 records 16 kHz mono to a local file
                                 live STT (on-device) → looks for the stop phrase
                                 stop: phrase | band | WebMCP stop | max length
                                 trim phrase, encode, upload
                                                    │ PUT /v1/notes/:id/audio
                                                    ▼
                               API → object storage → job transcribe_voice_note
                                                    │ packages/model, NOTES_TRANSCRIBE_MODEL
                                                    ▼
                               Phone/web app: page → notes, audio + transcript
   Glasses get the stop event → indicator off, "Saved"
```

## Glasses (`apps/glasses`)

### Component

A new component type in `packages/applet-format`, placed on a view by the
authoring model, e.g. `{ type: 'voiceNote', id, label? }`. One per view at
most. It renders in `packages/glasses-ui` with large, bright, heavy content
and no scrim, and must fit the page (the fit guard applies; no scrolling).

States:

| State | Shows |
| --- | --- |
| Idle | Mic glyph, "Say *Hey Meta, record a note*", "N notes on your phone" when N > 0 |
| Starting | "Connecting to phone…" (until the phone confirms recording) |
| Recording | Bright REC dot + elapsed time, "Say *stop recording meta*" |
| Saved | "Saved" for about 2 s, then idle (count + 1) |
| Unavailable | "Open the Applets app on your phone" (bridge not connected) |

The hint text comes from the component, not the model, so the wording is the
same everywhere and always fits. The band can focus the component and pinch to
start or stop.

### WebMCP tools

Built-in tools, registered only while the open view has a voice note component.
They come from the same `appletTools()` list, so the voice bridge can call them
too:

- `start_voice_note`: no args. The description tells Meta AI to call it when the
  user asks to record or take a note on this page.
- `stop_voice_note`: no args. This is an extra way to stop, in case Meta AI
  still hears "Hey Meta" while the phone holds the mics (unknown #1).

Voice notes don't change applet state. They aren't actions, never pass through
`dispatch`, and never appear in state backups.

### Network

Starting a note needs the network: the glasses tell the API, and the API tells
the phone. This is a second documented exception to "no network during normal
use" (the voice bridge is the first). If the request fails, show Unavailable;
nothing is recorded. The "N notes" count comes from sync (per view counts in
the library manifest) plus the notes this device started since the last sync.

## Phone bridge (iOS + Android)

- **Start:** the bridge subscribes to note events for the user (same SSE/event
  hub as the voice bridge). On `start`, it begins writing the HFP input to a
  local file and confirms back (`POST /v1/notes/:id/recording`).
- **iOS:** a background app can't *begin* recording. So the bridge keeps an
  `AVAudioEngine` session running from the moment the user starts it in the
  foreground, and a note only marks where it starts and ends in the stream. Android
  can open the mic on demand from its `microphone` foreground service.
- **Voice command mode:** if the always-listening command resolver is on,
  it pauses during a note, so dictation can't trigger applet actions.
- **Live stop detection (cheap):**
  - iOS: `SpeechAnalyzer` / `SFSpeechRecognizer` with
    `requiresOnDeviceRecognition`, `en-US`, contextual strings
    `["stop recording meta"]`.
  - Android: `SpeechRecognizer.createOnDeviceSpeechRecognizer` (API 31+), en-US.
    Fallback on phones without it: Vosk small English model with a grammar
    limited to the phrase plus `[unk]`.
  - Last resort if on-device is unreliable: short VAD clips to the cheapest
    cloud STT. Measure first; don't build it upfront.
  - Match tolerantly at the end of a partial transcript: "stop recording"
    followed by something that sounds like "meta" (meta/metta/better/medal), within
    the last ~2 s. The live text is never uploaded or stored.
- **Other ways to stop:** band pinch (via glasses → API → phone),
  `stop_voice_note`, maximum length (default 5 min, with a warning on the
  glasses at 4:30), glasses disconnect, phone call or interruption.
  `end_reason` records which one fired.
- **Trim:** cut the audio from the start of the detected phrase (word timings
  where the recognizer gives them, otherwise phrase time minus 0.3 s). Keep
  300 ms of pre-roll at the start. Notes under 1 s of speech are discarded with
  "Nothing recorded" on the glasses.
- **Upload:** AAC (iOS) / Opus (Android) mono at 16 kHz; that's tiny. Uploaded
  through the API (never directly to Verda), retried until it succeeds. The
  local file is kept until the server confirms the SHA-256, so a note survives
  being offline and is uploaded later.

## API and data

New routes in `apps/api/src/routes/notes.ts` (document in [api.md](api.md)):

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /v1/notes` | glasses | Create with a client UUID (idempotent): project, release, view, component, state snapshot. Pushes `start` to the bridge |
| `POST /v1/notes/:id/stop` | glasses | Band or WebMCP stop. Pushes `stop` |
| `POST /v1/notes/:id/recording` | bridge | Phone confirms recording started, so the glasses switch to Recording |
| `PUT /v1/notes/:id/audio` | bridge | Upload trimmed audio + `end_reason`, duration. Enqueues transcription |
| `GET /v1/projects/:id/notes` | phone/web | Notes grouped by view, newest first |
| `GET /v1/notes/:id/audio` | phone/web | Stream audio (API proxies object storage) |
| `PATCH /v1/notes/:id` | phone/web | Edit transcript text |
| `DELETE /v1/notes/:id` | phone/web | Delete note + audio object |

Table `voice_notes` (new migration, document in [database.md](database.md)):
`id` (client UUID), `owner_id`, `project_id`, `release_id`, `view_id`,
`component_id`, `state_snapshot` (jsonb), `started_at`, `ended_at`,
`duration_ms`, `end_reason`, `audio_key`/`audio_sha256`/`audio_bytes`,
`status` ∈ recording, uploaded, transcribing, transcribed, failed, abandoned,
`transcript`, `transcript_edited`, `transcript_model`, `language` (`en`).
Every query filters by owner. A `recording` note with no audio after 15 min becomes
`abandoned` (the bridge may still upload it later; accept the upload).

Notes are linked to the view ID, not the layout. If a later release removes
the view, the notes stay and are listed as "from a removed page". Never
delete them because of a layout change.

**Privacy:** this feature stores audio and transcripts by design, unlike the
command bridge, which never does. Delete removes the object as well. Logs carry
ids, durations, model, cost and status, never audio or text.

## Model choice

Picked from published word error rates (owner decision: no own paid bench),
Artificial Analysis AA-WER v2 leaderboard read 2026-11-14 (lower is better;
price per 1,000 minutes of audio):

| Role | Model | AA-WER | Price | Why |
| --- | --- | --- | --- | --- |
| Final transcript | `mistral:voxtral-mini-transcribe-3` | 2.2% | $3.50 | Top-6 overall, almost the same WER as Voxtral Small Transcribe 3 (2.1%, $4.00); supports `context_bias` for applet words. A 5-minute note ≈ $0.02 |
| Live stop check | `google/gemini-3.1-flash-lite` (OpenRouter) | 3.4% (Flash-Lite Preview, minimal) | $1.10 | Cheapest model with a decent published WER that our chat path already supports; it only has to spot one phrase in a 5 s window |

The models chosen earlier (`gemini-3.8-flash`, `gemini-3.5-flash-lite`) had no
published WER. More accurate options exist outside our providers
(ElevenLabs Scribe v3 1.9%, MAI-Transcribe-2 2.0%); adding one is a new
`TranscriptionProvider` in `packages/model`. AA-WER is measured on agent
talk, parliament speech and earnings calls, not on 8–16 kHz Bluetooth audio
from glasses, so real error rates on our notes are unknown until tested.

## Final transcription

Job `transcribe_voice_note` (document in [jobs.md](jobs.md)). It's safe to run
twice: it skips the note if already transcribed with the same audio hash.

- Through `packages/model` (the `audio` part already exists). Configurable with
  `NOTES_TRANSCRIBE_MODEL`, plus `fake:` for tests. Long audio may need chunking
  at silence boundaries, depending on the chosen model's limits.
- Prompt: "verbatim English transcript, no summary", plus a vocabulary hint
  from the applet (title, view labels, list items: crochet terms, ingredient
  names). This is cheap and improves accuracy a lot.
- Candidates to bench (small real spend, owner approval first): an
  OpenAI-compatible transcription model, the audio-capable Gemini Flash Lite
  models on OpenRouter, and a hosted Whisper large-v3 turbo. Score word error
  rate on 10–20 real HFP notes with domain words, plus cost per minute.

## Phone/web app (`apps/author`)

For each project: views (pages) listed with their note count. Each page has
notes, newest first, each with timestamp, duration, audio player, transcript
(status pending → final, editable), the state snapshot as context (e.g. "Row
14"), and delete. Later: export, re-transcribe, a combined notes view.

## Unknowns to settle on the device (M0)

1. **Does Meta AI still hear "Hey Meta" while the phone holds the glasses mics
   over HFP?** On iOS the session stays open the whole time, so if the answer is
   no, the second note can't be started by Meta. Fallbacks: band pinch on the
   component, or our own start phrase detected by the bridge. *Biggest risk.*
2. Does "stop recording meta" (no "Hey") ever wake Meta AI?
3. On-device recognizer accuracy on the stop phrase at the HFP rate (8 vs
   16 kHz), with background noise, on both phones. Count missed and false stops.
4. Start latency: from Meta's tool call to the phone actually recording. The first
   words may be lost, so measure, and ask the user to wait for REC if needed.
5. iPhone locked in a pocket for 30 min with the session open: battery, and
   whether recording still starts on event.

Record the results here with firmware and app versions.

## Milestones

- **M0 device spike:** answer unknowns 1–5 with a bare bridge build and a
  test page on the glasses.
- **M1 no-phone end to end (no spend): done** (headless Chrome, not the
  simulator extension). Also done beyond M1: the web recorder in the
  authoring app.
- **M2 Android bridge** (no Mac needed): on-demand recording, on-device stop
  phrase, trim, offline upload queue.
- **M3 iOS bridge:** continuous session, SpeechAnalyzer stop phrase. Needs a Mac.
- **M4 models: chosen from published WER** (see [Model choice](#model-choice));
  no own bench. Still worth one real note through each before relying on it.
- **Later:** more languages, re-transcribe, export, notes in the authoring
  thread as input for the next applet revision.
