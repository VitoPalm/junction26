# Video prototype test results

Tested locally on 2026-11-14. No glasses hardware was used.

## Real YouTube and model test

Source: [Crochet tutorial: how to crochet a chain stitch — hibouchoucaillou](https://www.youtube.com/watch?v=oXkC52p_xE0),
56.1 seconds. yt-dlp `2026.10.26` downloaded a 720p video-only stream with no
cookies or login. FFmpeg/ffprobe decoded it locally.

The paid harness used `openai/gpt-6.1-sol` through `packages/model` / OpenRouter:

1. Inspected twelve timestamped overview frames and selected a short interval.
2. Inspected 24 denser frames, then chose a crop and source interval.
3. Validated the plan. The model used a hyphenated ID despite the JSON schema;
   validation rejected it. One exact-error repair produced an underscore ID.
4. Encoded the selected 47.833–50.5 s interval at 6 fps, 240 px width into a
   258,591-byte looping GIF (16 frames). Decoded start/middle/end frames retain
   the hook, yarn and hands. This is a visual spot check, not expert validation
   of crochet technique or proof that arbitrary tutorial actions are complete.
5. A further model call authored an image-only applet referencing that GIF.
   Source hydration retained the animated bytes; definition validation and
   canonical 600×600 Chrome fit checks passed. No playback controls were added.

Six total paid calls across one failed run and one completed run cost
**$0.0478953**, within the owner's **$3** authorization. The failed run stopped
on the invalid ID before encoding. The successful run included one bounded plan
repair. There were no unreported/unknown-cost calls in the test ledger.

Raw local evidence, including exact responses, pricing snapshots, source frames,
GIF, applet definition and cost receipts, is under `.data/video-testing/paid/`.
The successful run is `run-1794671023097`; raw material is git-ignored.
The selected snippet is available locally at
`clips/yarn_over_pull_through.gif` within that run. Source metadata and attribution
remain attached to the manifests; no tutorial media is committed to the repo.

## Failures found and corrected

- **YouTube format selection:** requesting `best` required a combined audio/video
  stream absent from this tutorial. Selecting `bestvideo` first successfully
  imports its separate video stream. Audio isn't needed for GIF encoding.
- **Very short / low-frame-rate storyboards:** sampling beyond the last frame
  of a one-frame video failed. Sampling now stops at the last frame interval,
  uses PNG output and verifies that each frame file exists. A 0.5 s, 2 fps
  regression test checks all twelve returned files and honest timestamps.
- **Unnecessary upscaling:** small source regions were enlarged before encoding.
  Both storyboard and GIF conversion now bound dimensions without upscaling.
- **Model schema compliance:** structured output alone did not enforce the ID
  pattern. The paid harness now validates and allows one exact-error repair;
  it never silently rewrites model-chosen timestamps or movement content.

## Automated coverage

The free worker suite covers real FFmpeg conversion, changing decoded GIF
frames, infinite looping, timing and the 96-frame boundary, portrait crops,
no upscaling, corrupt/audio-only/oversized/over-duration inputs, invalid plans,
cancellation, preserving existing output and CLI failure cleanup. A stubbed
downloader guards video-only format selection and canonical URL arguments;
ordinary tests never fetch YouTube or spend model credit.

Chrome checks exercise GIF pages and sequence steps, source decode, layout fit,
absence of player controls, and removing/recreating the image on document
visibility changes. The broader worker suite also covers source ownership and
job execution. Worker TypeScript checks pass.

## Reproduction

Free tests:

```sh
npm run build:fit -w @junction26/worker
npm run typecheck -w @junction26/worker
npm test -w @junction26/worker
```

Requires FFmpeg/ffprobe, Chromium and the existing Node dependencies.
For another deliberately paid run, first acquire the same tutorial source as
`.data/video-testing/source/source.mp4`, then:

```sh
node --env-file=.env.openrouter.local --conditions=junction26-source \
  scripts/model-bench/video.ts --paid
```

Run one paid harness at a time. It retains receipts across invocations, checks
current model prices, reserves a conservative request allowance, stops before
the cumulative $3 ceiling, and blocks further paid calls after an unknown cost.
It does not run through `npm test` or retry failed network/model calls.

Remaining gaps: automatic chat import, captions/audio, broader tutorials and
dance footage, evaluation of source fidelity, real-glasses readability, memory,
animation performance and storage behavior. The paid harness assembles the
future builder stages explicitly; it does not prove an integrated chat flow.
