# Managed authoring pipeline

Implemented and exercised against real OpenRouter Luna on 2026-11-14. This is
local HTTP/PostgreSQL/headless-Chromium evidence, not hardware verification or a
deployed service. See [model-pipeline-results.md](model-pipeline-results.md) for
paid benchmark evidence and remaining gaps.

## Flow

1. The phone streams each file through the authenticated API into object storage.
   Upload type/size checks run while streaming. A durable `prepare_upload` job
   prepares a manifest next to the source object (`<objectKey>.prepared-v1.json`).
2. Preparation extracts text and renders PDF pages, or normalizes images. It
   preserves the original uploaded object. Text, source/page labels, image refs,
   warnings and normalized PNGs form the cached manifest. An interrupted job can
   safely regenerate it at the same key. No SQL migration is required.
3. Generation loads owner-filtered source uploads from the conversation through
   its selected message, plus its base definition (without image bytes in the
   prompt). Previously attached files remain available for follow-ups. Source
   processing can run on a `stored` upload as well as a `ready` one, so generation
   does not depend on which worker claims upload preparation first.
4. Explicit user URLs are read before generation. Luna can call `read_url`,
   `search_web`, `search_images` and `crop_image` to gather further context.
   Files, web content and tool results are untrusted source data in the prompt.
5. Luna returns a complete definition or a clarification/unsupported-feature
   reply. Validate the JSON envelope, schema, references, copy, runtime version,
   action docking and checklist wiring. Every generated image must resolve to a
   supplied source ref or a preserved base asset; generated base64 and invented
   upload IDs cannot introduce images.
6. Hydrate referenced image bytes on the server, preserving source attribution.
   Render every default-state view, sequence step and list page in headless
   Chromium at 600×600 using the canonical glasses components. Fit and image
   decode failures join the model's repair feedback. Up to two repair attempts
   retain tool context and report exact failing paths.
7. Save the valid revision and user-facing reply transactionally. Packaging embeds
   images in `definition.assets[].data`, which the existing preview and glasses
   renderer consume offline. The reserved top-level package `assets` slot remains
   empty for compatibility. Images are not fetched at applet runtime.

No authoring requests originate from the glasses in this implementation.

## Supported sources

| Source | Preparation | Limits / exclusions |
| --- | --- | --- |
| PDF | Poppler text extraction and PNG rendering of every page; scanned pages reach Luna as images | 24 pages; encrypted/malformed PDFs fail; no automatic OCR text layer |
| PNG, JPEG, WebP uploads | Apply orientation, flatten to white and normalize to PNG | 40 million input pixels; longest side at most 1200 px |
| Plain text, Markdown | UTF-8 source text | 120,000 characters; UTF-16 is not supported |
| CSV | UTF-8 source text, interpreted by Luna | Preserve quantities in state/copy; no spreadsheet calculation engine |
| JSON | Parse to check validity, then provide original text | Same text budget |
| HTML file or public page | Extract main/article/body text and image candidates; omit executable/navigation content | No browser/JavaScript execution, login, paywall bypass or video playback |
| Word `.docx` | Read paragraphs and tables from `word/document.xml` | 2 MiB XML expansion, 2,000 archive entries; drawings/layout not imported; use PDF for visual fidelity |
| Public image URL | Download and normalize raster/SVG to PNG | Same image/download limits; inspect sources and reuse terms |

The phone's picker and extension fallback include these upload types. XLS/XLSX,
legacy `.doc`, HEIC, audio and video are not supported. These require an explicit
conversion/import path rather than pretending that the model read them.

## Source tools and network boundaries

`read_url` handles public HTTP(S) text, PDF and image sources. It rejects
credentials, custom ports, private/reserved IPv4 and IPv6 addresses, loopback,
link-local metadata endpoints and private DNS answers. DNS answers are validated
and passed directly to the connection lookup; redirects undergo the same checks.
Known PDF/raster magic bytes are recognized even if a source server sends a generic MIME type. Downloads have a 20-second deadline, four redirect hops and a 12 MiB byte cap,
including responses without a Content-Length header.

`search_web` uses the configured model adapter's bounded OpenRouter Responses
request with `openrouter:web_search`, Parallel fast search, at most one server
tool call, three results and 1,800 output tokens. It is a separate call from
schema-constrained final authoring. Its reported tokens/cost join job usage.
Other model providers receive an explicit unavailable-tool result.

`search_images` searches Wikimedia Commons, returning image URLs, descriptions,
license labels and attribution links. Short subject queries work better than
sentences about licensing. The model must fetch and inspect a chosen image before
referencing it. Attribution follows the imported image and its crops.

`crop_image` takes a known image ref and normalized coordinates. It creates a
server-owned PNG ref with source/crop provenance. It cannot read arbitrary files.
Crops need an overview or other context when orientation/callouts matter.

A generation allows eight source tool executions, eight fetched URLs, two web
searches, 20 conversation uploads and 32 supplied images. Initial source context
is bounded at 20 MiB; accumulated tool/chat content at 24 MiB. PDF preparation also stops when rendered image data exceeds 20 MiB, and cached manifests are capped at 32 MiB. Sources fail with
clear excerpt requests rather than silently dropping pages. All tool calls,
repairs and searches remain subject to the worker lease/cancellation signal.

## Runtime and development

The worker now needs Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and Chromium.
The container installs `poppler-utils` and `chromium`. Locally Chrome is found at
`/usr/bin/google-chrome-stable`, or set `CHROME_PATH`. Run:

```sh
npm ci
npm run build:fit -w @junction26/worker
npm run dev:db
npm run dev:worker
```

`npm run build -w @junction26/worker` creates the offline renderer bundle in
`apps/worker/fit/` after TypeScript compilation. It contains the canonical renderer,
toolkit, styles and fonts; it is not shipped to the phone or glasses. The checker
uses an intercepted local document and blocks outgoing page requests. No web
server is needed for measurement.

The worker reports `searches` and `toolUses` alongside input/output tokens,
`costUsd` and model spec in generation usage. Known usage on terminal validation
failures is included in structured error details. Provider costs on ambiguous
network failures and cancelled jobs still need reconciliation; this is not a
billing system or per-user spending limit.

## Reproducing paid tests

Normal `npm test` never spends model credit. Paid tests require `--paid`:

```sh
TEST_DATABASE_URL=postgres://j26:dev@127.0.0.1:55432/postgres \
node --env-file=.env.openrouter.local --conditions=junction26-source \
  scripts/model-bench/run.ts --paid --case=counter,manual,image,link
```

Use `--repeat=3`, `--effort=low` (default benchmark effort: medium), and `--s3`
with `--env-file=.env.verda.local` for real object storage. It creates an isolated
PostgreSQL database, serves the real Hono app on loopback, processes durable jobs
with the production handlers, calls real Luna, publishes/downloads packages and
probes runtime actions. The S3 variant deletes only its own temporary database's
upload/manifests/packages before dropping that database.

A persistent `.data/model-bench/calls.jsonl` records every paid call, including
searches and failed-candidate repairs. The harness reserves $0.25 before each
call and stops before a cumulative $3; missing provider cost stops further
inference until reconciled. Run one paid harness at a time. Raw requests,
responses and detailed results stay in ignored `.data/`, because they can contain
source material. The small evidence summary in docs contains no credentials.

Provider reference: [OpenRouter server web search](https://openrouter.ai/docs/guides/features/server-tools/web-search).
