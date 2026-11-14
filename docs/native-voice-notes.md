# Native voice-note recorders

Implemented on `feat/voice-notes`, 2026-11-14. Android debug APK compilation,
JVM audio tests and lint pass. iOS source is registered in the Xcode project,
but has not been compiled: this Linux device host has no macOS/Xcode target.
The Android emulator exited with SIGSEGV on both the Device panel launch and
its suggested manual retry. No physical phone or glasses behavior is verified.

## Runtime

The Capacitor app selects `NativeNoteRecorder` instead of the web recorder.
Native code owns the microphone, event connection, stop detector, note timeout,
local files and uploads; none depend on JavaScript timers continuing under lock.
The shared React Recorder screen observes native status and keeps the same
controls. Web builds retain AudioWorklet/Web Speech/IndexedDB behavior.

- Android: `NoteRecorderPlugin` starts `NoteRecorderService` from the visible
  app after permission requests. A microphone foreground service shows an
  ongoing notification with Stop. A partial wake lock is bounded by the session
  expiry. Capture starts per note, with an HFP communication route preferred.
  API 33+ injects the same PCM into an on-device SpeechRecognizer, avoiding a
  second microphone owner. Unsupported devices or recognizer failures use the
  existing cloud stop check. Older Android versions do not bundle Vosk.
- iOS: `NoteRecorderPlugin` starts AVAudioEngine from the foreground, using
  playAndRecord/voiceChat and preferring a Bluetooth HFP input. Background audio
  mode keeps the continuous session eligible to run under lock. Only 300 ms of
  idle pre-roll is held in memory; idle audio is not stored or uploaded.
  SFSpeechRecognizer receives the captured audio buffers with on-device
  recognition required. Unsupported/unavailable recognition falls back to cloud.
  Calls and input removal save partial notes and require re-enabling recording.
- Both: stop phrase, band/WebMCP stop, note time limit, or interruption ends a
  note. The PCM is converted to a 16 kHz mono PCM16 WAV. Pause-based trimming
  removes the stop phrase; the cloud detector can supply a precise cut point.
  Final transcription cleans a trailing command again.

## Authentication and queue

The foreground app obtains a 12-hour recorder-only credential using its current
user session. Native networking keeps it in memory. It cannot read existing
notes or author projects; see [api.md](api.md#native-background-recorder-sessions).
The service must be enabled again after session expiry or process termination.
Turning off/signing out stops capture and attempts server revocation. Native
account sign-in comes from the separate Clerk native-auth implementation.

Note metadata and PCM are written to app-private files while recording. Android
uses no-backup storage; iOS excludes the directory from backups and permits file
access after the first unlock. Queue directories include API server and owner,
so another account never uploads those files. Completed WAVs survive connection
loss and process restarts. Re-enabling recovers interrupted PCM and retries the
queue. An upload must succeed and return the exact local SHA-256 before files
are deleted. Turning off before upload completes leaves the note queued for the
next time that owner enables the recorder. App uninstall removes local files.

## Build

```sh
npm run cap:sync -w @junction26/author
# Android SDK and JDK 21+ with javac required:
cd apps/author/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
# macOS: open apps/author/ios/App/App.xcodeproj, select signing team,
# build App for an iPhone; enable recorder while app is visible.
```

No model-provider keys go in the app. The backend defaults to
`openrouter-stt:mistralai/voxtral-mini-transcribe-3-0` for final transcripts and
`google/gemini-3.1-flash-lite` for cloud stop checks, using the existing backend
`OPENROUTER_API_KEY`. The real OpenRouter smoke test returned the intended text
from a 3-second synthesized English clip, with reported cost $0.000175.
A separate synthesized stop-phrase clip returned `stop: true` with a 2.1-second
phrase-start offset from Gemini Flash-Lite; reported cost $0.00009925.
The integrated branch passed 167 unit tests (including fresh database tests,
no skips), four glasses WebMCP browser tests, five canonical no-scroll browser
tests, the full build, and Android APK/unit/lint checks. Capacitor iOS sync and
plist validation pass; neither compiles the Swift code.

## Remaining device verification

Build iOS on Xcode before treating M3 as usable. On each physical platform,
verify permission denial, actual glasses HFP input, Meta start while the phone
holds the mic, phrase detection in noise, band stop, trimming and audio playback.
Then check 30 minutes locked, a call/Bluetooth disconnect, offline upload and
process-kill recovery, account switching, and session expiry. Record phone,
OS, firmware, route and results in [voice-notes.md](voice-notes.md).
