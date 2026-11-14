# Video tutorials and looping GIF components

Owner direction (2026-11-14): prioritize **YouTube links**, and show **automatically
looping GIFs with no playback controls** on the glasses. Selecting snippets,
cropping and any speed changes belong to authoring. Ordinary guide Previous/Next
navigation remains; leaving a step does not complete a stitch or increment a counter.

## Implemented foundation

- `image/gif` assets work in existing `image` views and sequence `image` steps.
  They use `LoopingImage`, bypassing `Diagram`'s canvas ink conversion, which
  would freeze motion at the first frame. No play/pause/scrub/speed controls.
- Uploads, the authoring file picker and public direct GIF URLs accept GIFs.
  Preparation resizes to at most 360×360, preserves frames and forces infinite
  looping. At most 8 seconds, 96 frames and 512 KiB per prepared GIF; managed
  generation permits 2 MiB total GIF bytes. Larger inputs fail explicitly.
- The model receives a PNG first-frame preview and a motion ref. Only server
  resolution inserts the GIF bytes in the definition; base64 motion never enters
  the model context. A first-frame preview does **not** establish motion fidelity.
  `crop_image` refuses animated sources rather than silently freezing them.
- Preview and offline packages use the same embedded GIF. Hidden documents
  remove the image decoder; returning shows the loop again. Domain state is
  independent. There are no network requests for playback.
- GIF definitions require minimum runtime `0.2.0`. Older static definitions
  remain valid. The format is still version 1.

These are local implementation and desktop-test results. Real-glasses animation,
performance, memory, background handling and readability remain **unverified**.
GIFs retain source colors: they do not get diagram ink processing. Bright subjects
and useful close-ups matter on an additive display; a dark backing cannot help.
Real YouTube/model test evidence and regression findings are recorded in
[video-prototype-results.md](video-prototype-results.md).
The follow-up [whole-crochet trial](whole-crochet-results.md) produces a complete
16-step heart applet containing six distinct GIF demonstrations.

## Local YouTube → snippet prototype

`scripts/tutorial-video.ts` is a developer CLI, **not wired into authoring chat**.
It accepts a local video or a canonical single-video YouTube URL. The YouTube
adapter needs `yt-dlp` (or `YT_DLP_PATH`); FFmpeg and ffprobe are required for
conversion. It uses no login cookies and does not retry around access challenges.
Blocked sources fail; ask for an accessible video file in the future product flow.

Get timestamped overview frames (no model calls or model credit):

```sh
node --conditions=junction26-source scripts/tutorial-video.ts \
  --youtube 'https://www.youtube.com/watch?v=VIDEO_ID' \
  --out .data/tutorial-overview
```

Use `--input /absolute/path/tutorial.mp4` instead for a local file. The manifest
lists timestamps and 12 frame files. These are navigation hints, **not sufficient
evidence of a stitch or choreography**. Inspect candidate intervals densely before
choosing boundaries. Audio and captions are not extracted in this prototype.

Provide a JSON plan (the future builder tool's data contract):

```json
{
  "sourceUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "clips": [{
    "id": "pull_through",
    "start": 42.5,
    "end": 45.5,
    "label": "Pull yarn through both loops",
    "crop": { "left": 0.1, "top": 0.1, "width": 0.8, "height": 0.8 },
    "fps": 10,
    "width": 320
  }]
}
```

Then run the same command with `--plan plan.json --out .data/tutorial-clips`.
Each clip produces a GIF, a PNG poster and a manifest containing source timestamp,
crop, byte count, hash and transfer estimate. Upload the GIF through the existing
authoring picker to use it now. Source metadata currently stays in the CLI
manifest; it is not automatically associated with that separate upload.

Output directories must be new. Failed CLI imports are removed before activation.
Inputs are limited to 12 minutes, 128 MiB and 4K; 8 clips per plan, 0.5–8 seconds
each, 4–12 fps, 120–360 px requested width, 96 frames, 512 KiB each and 2 MiB total.
The encoder rejects incomplete output instead of silently shortening a movement.
No mirroring, frame interpolation, synthesized frames or speed changes are applied.
Oversized clips require a shorter interval, tighter crop or lower resolution/fps.

FFmpeg process arguments are constructed from validated numeric data, not model
commands. The decoder permits local file/pipe protocols only. The YouTube adapter
canonicalizes IDs and ignores downloader configuration; **it is not a production
network sandbox**. yt-dlp performs its own network requests. Do not expose this
CLI as an API handler or attach it to `read_url` without isolated egress controls.

## Proposed builder integration

1. A source-import adapter resolves a YouTube link on the backend, preserves the
   video ID/title/creator/source URL, obtains accessible media and time-aligned
   captions, and reports missing audio/captions explicitly. Keep originals on
   the server, outside glasses packages. Avoid fetching YouTube as ordinary HTML
   and claiming the model watched it.
2. Give the selected capable builder timestamped overview frames and captions.
   Add `inspect_video(sourceRef,start,end)` to return dense, timestamped frames
   for bounded intervals. Crocheting needs hook/yarn detail; dance needs complete
   feet/body positions and enough lead-in to understand direction.
3. Add `cut_video_gif(sourceRef,start,end,crop,fps,width)` using the tested
   deterministic encoder. Models select meaningful motion boundaries; code
   validates and cuts. Source refs must be owner-scoped, never paths or arbitrary
   stream URLs. Model access remains through `packages/model`.
4. Return GIF refs plus sampled encoded frames for review. Check that the
   complete action survives the crop, first/last frames make a sensible repeat,
   and no essential spoken cue was lost. Include an overview/detail pair when
   needed. Preserve handedness; don't silently mirror dance footage or convert
   right-handed crochet into left-handed instructions.
5. Reuse existing source hydration and offline packaging. Record source interval,
   crop and attribution alongside each asset. Fit-check every GIF step with the
   canonical renderer; verify motion fidelity in phone preview before publish.
   Do not let changing a visual reset row counts or saved guide progress.

A second model is not necessary just to cut video. Start with the user-selected
capable authoring model deciding intervals and fixed tools doing the work. Native
video understanding can be added behind provider capabilities later; providers
without it can inspect frames, with explicit coverage limits. A paid crochet-video
trial now exercises interval selection, clip-plan repair and GIF applet authoring;
see the linked test results.

Production work remaining: isolated importer and deployment dependencies,
durable retry-safe source jobs, caption/audio ingestion, dense-frame tools,
automatic metadata association, source-selection UI, broader YouTube testing and
device verification. Generic `read_url` still does not import video content.

## Why GIFs here

GIF is the owner-selected first output, independent of the source video format.
It supports the desired simple loop without media controls. It is not assumed to
be the smallest transport: [Google's WebP reference](https://developers.google.com/speed/webp/)
documents smaller animated alternatives. Keep the source/clip contract separate
from encoding so a future device-tested transport can change without changing
the builder's selected intervals.

Encoding references: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)
(`fps`, `scale`, `palettegen`, `paletteuse`),
[yt-dlp options](https://github.com/yt-dlp/yt-dlp). An online
[YouTube embed](https://developers.google.com/youtube/iframe_api_reference)
is useful for inspecting source timestamps on the phone, but cannot supply the
offline glasses package by itself.
