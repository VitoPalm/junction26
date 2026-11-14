# Experiments and lessons

All trials used the IKEA TROTTEN underframe manual (16-page PDF, AA-2241566-6-2;
copies in each experiment's `upload/` or `input/`). Every experiment folder keeps its
exact prompts, raw outputs and evaluation. **Don't edit recorded evidence.** The
`run.py` scripts make paid API calls and refuse to run while a `response.json`
exists. Archive the folder first if you deliberately want a new run.

| Trial | Setup | Result | Folder |
| --- | --- | --- | --- |
| Luna via Codex | Coding agent (`gpt-6-luna`, Codex tools) writes a React app from the component library | Builds and has navigation and resume, but misreads steps, omits parts inventory, full-page white diagrams, scrolling | [`experiments/luna-ikea`](../experiments/luna-ikea/README.md) |
| OpenRouter v1 | Production-shaped: backend renders pages → one structured-output call → validated JSON → fixed renderer | 48 s, **$0.00712**, schema-valid first try; content errors (step 1, missed tightening, unsupported warning) | [`experiments/openrouter-ikea`](../experiments/openrouter-ikea/README.md) |
| OpenRouter v2 | Same pipeline, broadened visual-first guidance, schema allows image-only views | 42 s, **$0.00681**; chose diagrams for every step, no prose; still added redundant headings and dropped the safety page | [`experiments/openrouter-ikea-v2`](../experiments/openrouter-ikea-v2/README.md) (live demo) |

## Lessons that shaped the design

1. **Generating data into a fixed runtime beats generating code.** It's cheap
   (under a cent), validates, and keeps rendering, navigation and persistence
   under our control. A plain API model only has the tools we give it, so the
   backend must prepare the material (render pages, extract text).
2. **Structural validity isn't source fidelity.** All runs produced valid
   output that would still mislead a builder in places. Accuracy review
   (automated checks plus human-visible source references) is a product
   feature, not a test detail.
3. **Visual-first guidance works when the schema allows it.** v1's schema
   required text on every step, which forced redundant prose. v2 made text
   optional and the model went fully visual. Make the schema express the
   policy.
4. **Display adaptation is the runtime's job, not the model's.** Inverting
   dark-on-white art, cropping and thickening lines are deterministic
   (`bundle.py` + `packages/glasses-ui/src/lib/ink.ts`).
5. **The additive display defeats blur and dark panels.** Only emitted light
   helps. See [glasses-platform.md](glasses-platform.md#additive-display).
6. **Dense source pages need detail views.** The full parts sheet is legible
   but small at 600×600; the generator should split such pages.

## Running the demos

```sh
npm ci                                            # repo root
cd experiments/openrouter-ikea-v2/app && npx vite --host 127.0.0.1 --port 4182
```

Open it in Chrome with the Meta Ray-Ban Display Simulator enabled. Arrow keys,
Enter and Esc work, with Background Blur at 0. Ports used historically: 4180 (v1),
4181 (library examples), 4182 (v2).

Pipeline reproduction (paid, ~$0.007): Python 3 + `requests` + `Pillow`, Poppler
(`pdftoppm`, `pdftotext`), `.env.openrouter.local`. `run.py` expects the source
PDF in `~/Downloads/`; change `source` to `upload/manual.pdf` when reproducing.
Then run `bundle.py` (no API call) to crop the diagrams and regenerate
`app/src/generated.json` and `assets.json`.
