# Complete crochet guide with multiple GIFs

Local trial on 2026-11-14. Source: Hooked by Robin's
[complete tiny-heart tutorial](https://www.youtube.com/watch?v=w9CXXsu6YSA),
298 seconds, its manual English captions, and the
[matching creator-written pattern](https://www.hookedbyrobin.com/blog/crochet-tiny-heart).
This tests a complete heart, not a cat plushie.

## Result

`openai/gpt-6.1-sol` selected **six different source snippets** and authored a
**16-step applet** covering supplies, US terminology, foundation, both sides of
the heart, joining, fastening off, closing the ring and weaving in both ends.
All six GIFs appear in the main guide, with essential stitch counts displayed
below the relevant animations. They loop without playback controls.

The six source intervals cover chaining, a treble pull-through, the bottom-point
treble, the second lobe, the slip-stitch join and closing the ring. These are
movement demonstrations, not footage of every repetition. The instruction text
retains all repeat counts. Combined GIF bytes are **1,118,700** before base64
packaging, within the current 2 MiB motion budget.

The resulting applet passed format/source validation and canonical Chrome fit
checks at 600×600. The interactive harness walks forward through every step and
back to the start, verifies all six GIF sources and their instruction text,
checks that only the current GIF is mounted, and confirms that the only buttons
are Previous/Next. A standalone offline preview and screenshots are generated
from the same component/runtime bundle.

A fresh model audit against **both** supplied sources found no omitted pattern
steps/counts or unsupported instructions. Manual inspection of the guide copy
also confirms the complete ordered pattern and finishing sequence. This is not
expert crochet verification or evidence that a novice successfully made it.
The source assumes magic-ring setup and basic stitches; this guide preserves
that assumption rather than inventing missing beginner instruction.

## Component and integration

`packages/glasses-ui/src/lib/gif.tsx` exports:

- `GifImage`: fits the animation without flattening it through canvas; removes
  its decoder when hidden; displays a useful decode-error message.
- `GifScreen`: contains the animation, optional essential instruction/hint and
  the host's guide navigation. It uses the existing fit guard and readable
  typography, with no scrolling, dark panel or playback controls.

The canonical applet renderer uses `GifScreen` for GIF image views and GIF
sequence steps. Phone preview and glasses therefore share it. Format validation
now permits text beside GIFs while retaining separate text/static-diagram steps.
The authoring prompt teaches this contract. A broken GIF's recovery message still
produces an `image_decode` generation error.

Free regression tests also encode **eight distinct GIFs from one video**, reject
a ninth, exercise captioned GIF navigation and decode failures, and retain the
earlier media-limit, cancellation and cleanup coverage. No ordinary test spends
model credit or accesses YouTube.

## Findings and budget

- The clip model supplied an empty optional source URL on its first outputs.
  Validation rejected these plans; one exact-error repair per clip corrected
  them. Future requests now explicitly include the known source URL.
- The older mixed-image validator initially rejected GIF captions. It now
  distinguishes GIF instructions from static diagrams, with regression tests.
  The final applet uses the original captioned 16-step model output.
- An initial audit saw only the written pattern and flagged legitimate spoken
  technique details. The corrected audit includes the manual captions and
  preserves the earlier audit as evidence; unsupported-content checks remain.
- One applet-authoring request lost its provider connection without a response
  or generation ID. Its **$0.606796 reservation remains held**, never counted as
  zero or described as a known charge. Recorded successful requests were reused
  on resume; snippet selection was not paid for again.

Cumulative video-test reported cost, including the earlier single-GIF trial, is
**$0.2185203**. Including the unresolved request's conservative held allowance,
**$0.8253163** is accounted against the owner's **$3** limit. Raw receipts remain
in the shared `.data/video-testing/paid/` ledger. The original single-video
benchmark stops on unknown cost; the new budget helper can continue only when
every unknown request has a finite allowance held below the same cumulative cap.

The standalone preview uses local/system fonts and suppresses the toolkit's
automatic Google Fonts fallback request. This fixture does not establish that
the deployed glasses shell has no startup font request; actual device typography
and startup behavior remain unverified.

## Evidence and reproduction

Raw source frames/captions, exact model responses, plans, GIFs, audits, applet
definition, screenshots and the self-contained `preview.html` are git-ignored at
`.data/video-testing/paid/whole-heart-1794672126378/`.

```sh
# Free checks and interactive preview regeneration:
npm run build:fit -w @junction26/worker
npm test -w @junction26/worker
npm test -w @junction26/applet-format
node --conditions=junction26-source scripts/model-bench/check-video-guide.ts \
  .data/video-testing/paid/whole-heart-1794672126378/definition.json

# Deliberately paid; requires the same source video and manual-caption files:
node --env-file=.env.openrouter.local --conditions=junction26-source \
  scripts/model-bench/whole-crochet.ts --paid
```

Run paid scripts serially. `--resume=<evidence-directory>` reuses recorded paid
responses and encoded snippets; failed requests keep their budget allowance.
This harness stages the future authoring pipeline explicitly. Automatic YouTube
import in chat, larger plushie patterns, beginner usability and real-glasses
animation/readability remain unverified.
