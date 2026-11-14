# Apps: authoring (phone/web) and glasses

Status (2026-11-14): **MVP built**. The full loop runs locally: describe →
generate → preview → publish → pair glasses → sync → use offline → back up
state. Checked in headless Chrome (phone viewport and 600×600 glasses) and in
the Android emulator (Pixel 6 Pro, Android 17). **Not checked on real glasses
or on iOS** (iOS needs a Mac). WebMCP was exercised only through the
development stub, not Meta AI.

## Pieces

```text
packages/applet-format/   format v1 (zod), validator, change diff, capability catalog, authoring prompt, fixtures
packages/applet-runtime/  pure state machine: dispatch, initialState, migrateState, built-in step navigation
packages/applet-renderer/ React renderer on glasses-ui + WebMCP adapter; used by glasses AND the phone preview
packages/model/           provider-neutral model adapter (OpenRouter / OpenAI-compatible / Anthropic / Gemini / fake)
apps/glasses/             Meta Ray-Ban Display web app (served at /glasses/)
apps/author/              authoring app: web (served at /author/) + Capacitor iOS/Android shells
```

Dependencies point down: apps → renderer → runtime → format. The worker uses
format + model. Nothing on the glasses imports the model package.

## Applet format v1

Source of truth: `packages/applet-format/src/schema.ts` (structure) and
`validate.ts` (references, copy budgets, op/field types, WebMCP names).
Differences from the draft in [implementation-plan.md](implementation-plan.md):
collections are arrays with `id` (models handle them better than records), and
action args are an array. Views: `text`, `value`, `list` (checklist with
`check`), `sequence`, `image`. Ops: `add`, `subtract`, `set`, `toggle`, `reset`,
`listAppend`, `listRemove`, `listUpdate`, `listAdd`, `listToggle`, `listClear`,
`move`, `goto`. Fixtures in `src/fixtures/` (row counter, D&D sheet, packing
list, pancake guide) double as glasses demo content and the fake model's output.

State migration on a new release keeps values with the same ID and type,
defaults new fields, and moves dropped/retyped values to `orphaned` instead of
deleting them (a later revision that brings the field back restores them).

## Models (swappable)

The worker never talks to a provider directly. A model is a spec
`provider:model`:

| Spec | Provider |
| --- | --- |
| `openai/gpt-6-luna` (bare = OpenRouter) or `openrouter:<model>` | OpenRouter, any model it routes |
| `openai:<model>` | Any OpenAI-compatible endpoint (`OPENAI_BASE_URL`, `OPENAI_API_KEY`): OpenAI, vLLM, Ollama… |
| `anthropic:<model>` | Native Anthropic Messages API (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`) |
| `gemini:<model>` | Native Google Gemini generateContent API (`GEMINI_API_KEY`, `GEMINI_BASE_URL`) |
| `<configured-id>:<model>` | Independent OpenAI-compatible endpoints configured with `MODEL_PROVIDERS` (hosted or local) |
| `fake:demo` | Free, deterministic: picks a fixture by keyword. For dev, demos without credit, tests |

`AUTHORING_MODEL` is the default; `AUTHORING_MODELS` (comma list) adds choices
for the in-app model picker. The API refuses anything not on the list. The picker
groups choices by provider, disables providers without local credentials, and
chooses an available model if the default is unavailable. This checks configuration,
not key validity, credit balance or live provider access. Secrets stay on the server.
Images/PDF pages are prepared by the backend; text-only models can use extracted
text but cannot interpret source diagrams. The picker explains that limitation.

See [model-providers.md](model-providers.md) for setup, compatibility options and
verification limits. All model access, including the API voice resolver, goes
through `packages/model`. New protocol adapters implement `ModelProvider`; hosted
services using Chat Completions need configuration rather than new worker code.
The prompt and local validation are provider-neutral.

Generation (`apps/worker/src/generate.ts`): thread + attachments (text inline,
images and PDFs as parts when the model supports them) + the current
definition → model (JSON schema response format) → validate → one repair call
with the exact issues → save revision + assistant reply. Usage and cost are
recorded on the job. Failures post a plain-language reply in the thread.

## Glasses app (`apps/glasses`)

- Home: latest 3 applets + `Older` + `Sync`/`Pair phone`. Unpaired, it shows
  the bundled examples.
- Opening resumes the last view; Back goes to the applet's view menu, then home.
- State in IndexedDB, written before an action is acknowledged. **No network
  during normal use.** Network only on Pair and Sync: library manifest →
  download changed packages (SHA-256 verified, validated, then activated) →
  restore server state for new installs → batched state backup → last-opened.
- WebMCP: one tool per action (`j26_<prefix>_<action>`) plus `read_state`,
  `open_view`, `next_step`/`previous_step`. Registered once per open applet
  (page transitions keep two routes mounted, and duplicate names are rejected).
- Service worker precaches the shell and every asset it references at install
  (runtime caching alone misses the first load's assets), and refreshes shell +
  assets together in the background. The router keeps home at `/glasses/` so
  reloads stay inside the worker's scope. Offline launch checked over HTTPS
  with the server unreachable (headless Chrome).
- First load ≈ 238 KB gzipped (budget 300 KB).
- Dev: `npm run dev -w @junction26/glasses` → http://127.0.0.1:5174/glasses/
  (proxies `/v1` to :8080). Add `?webmcp` to install the test stub, then
  `webmcp.list()` / `await webmcp.call('j26_dnd_heal', { amount: 2 })` in the console.
- Back on the device/simulator is browser history (the toolkit doesn't bind Esc).

Browser regression checks: `npm run test:browser -w @junction26/glasses`.
These run the real app in Chrome at 600×600 using the explicit development
WebMCP stub: action/read ordering, concurrent writes, manual input, invalid
arguments, IndexedDB reload persistence, page navigation and tool cleanup when
leaving an applet. Tool reads use the latest persisted session state even before
React renders an acknowledged write. This is local browser evidence; it does
not test Meta AI, the simulator extension's agent, or glasses voice routing.

### Full local browser flow checked, 2026-11-14

Manual browser run against a throwaway migrated PostgreSQL database, the real
API and worker, memory object storage, dev authentication and only `fake:demo`:

- Created a crochet row counter through the authoring UI; its generated preview
  rendered at zero, and publishing completed through the UI.
- Requested a pairing code through the authoring UI, entered it in the glasses
  browser app, and confirmed pairing downloaded the published counter.
- At 600×600, pressed Add row three times. Reopening showed three saved rows.
- Pressing Add row in the author's preview showed one there; the glasses copy
  stayed at three.
- Submitted revision 2 through the revisions API (the fake model cannot edit
  layouts): renamed the view label to Finished rows and reversed the two docked
  actions, preserving state/action/view IDs. Previewed and published via the UI.
- Before explicit Sync the glasses retained the old layout. Sync reported one
  update; opening showed the new label/button order and three rows. A full
  reload still showed three, with no fit-guard alert.
- Both releases were ready; the server backup contained `values.rows = 3`.

Follow-up found by inspecting that backup: during update sync, its envelope
`revisionId` named revision 2 while `snapshot.revision` still named revision 1.
`sync()` installs the new package before backing up old saved state; migration
is currently deferred to `loadState()`. Local progress survived this test, but
backup revision consistency and recovery after a schema-changing update need a
dedicated regression test/fix. This run did not establish those behaviors.

No paid model, Clerk login, Aiven deployment, Meta agent, hardware or offline
cold start was tested. The temporary API/worker and author dev server were
stopped, their test tabs closed and the throwaway database dropped afterwards.

## Authoring app (`apps/author`)

One React codebase: web build served at `/author/`, and Capacitor 8.5 shells
(`android/`, `ios/`). Hash routing so it works identically in both.

- Sign-in: Clerk accounts on the web, with a fresh session token per API request.
  The Vite dev server retains optional name-based `dev:<name>` login. Native
  Clerk sign-in remains pending; Clerk-mode native builds point to the web app.
  Setup: [authentication-plan.md](authentication-plan.md). Library home: a
  "What do you need?" composer (text + files) that creates the project and
  starts generation in one step (in-memory hand-off, `src/ui.ts`), a
  connect-your-glasses nudge while nothing is paired, and applet tiles.
  First-run "what you can make" sheet from the capability catalog. Chat with
  attachments and model picker; tap the title to rename. Preview: the real
  renderer in a 600×600 iframe (`preview.html`) framed as a lens, separate
  in-memory state, plus "Try saying" chips (calls the same WebMCP tools). Change review: the
  program diffs against what's on the glasses; data loss needs an explicit tick
  before publishing (client-side only until the reviews endpoint exists).
  Publish. Glasses screen: install deep link, pairing code with countdown
  (notices when pairing completes), device list.
- Naming: people see "solutions" (brand "Solutions"); the code says applet.
  See the decision log in [product-spec.md](product-spec.md).
- Look: warm light/dark themes from `prefers-color-scheme`, tokens at the top of
  `src/styles.css`, Bricolage Grotesque + Figtree from Google Fonts (system
  fallbacks), inline icons in `src/icons.tsx`.
- Web dev: `npm run dev -w @junction26/author` → http://127.0.0.1:5173/author/

### Android (emulator)

```sh
cd apps/author
npm run build:native && CAP_DEV=1 npx cap sync android    # CAP_DEV allows http://localhost API (dev only)
echo "sdk.dir=$HOME/Android/Sdk" > android/local.properties
(cd android && JAVA_HOME=<jdk-21> ./gradlew assembleDebug)
adb reverse tcp:8080 tcp:8080                              # emulator's localhost:8080 → host API
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Native builds read `apps/author/.env.native` (committed, public): Clerk mode
with the development `pk_test_…` key and `VITE_CLERK_ALLOW_DEVELOPMENT=true`.
Email sign-in is Clerk's web UI inside the WebView. Social sign-in (Google,
Apple, Facebook) uses our own buttons (`src/native-oauth.ts`): the provider page
opens in a Custom Tab / Safari sheet and Clerk redirects to
`com.junction26.applets://oauth-callback`, which reopens the app to finish the
sign-in (Clerk's own social buttons are hidden on native: Google refuses
WebViews). Production Clerk instances must allowlist that redirect under Native
applications. Not yet verified end to end on the emulator. The API must list
the WebView origin in `CLERK_AUTHORIZED_PARTIES`: `https://localhost` (Android),
`capacitor://localhost` (iOS, not yet accepted by config validation). On this machine the
emulator only boots with `-gpu host`; `-gpu auto`/software rendering segfaults
in the Vulkan/ANGLE renderer.

### iOS

`npx cap sync ios` then open `apps/author/ios/App` in Xcode on a Mac (Swift
Package Manager, no CocoaPods). Not built yet.

### Release builds

Set `VITE_API_BASE=https://<api-origin>` for `build:native`, don't set
`CAP_DEV`, and keep `capacitor://localhost` (iOS) and `https://localhost`
(Android) in the API's `CORS_ORIGINS`. App icons/splash are still Capacitor
defaults (`@capacitor/assets` can generate them from `assets/icon-1024.png`).

## Testing on real glasses (public HTTPS, dev backend)

The glasses need a public HTTPS URL, but the dev API trusts `dev:<name>`
tokens, which must never be public. `scripts/glasses-gateway.mjs` forwards only
the glasses app, pairing (rate-limited) and device-token requests; everything
else is 404. Authoring stays local.

```sh
mkdir -p /tmp/j26web && ln -sfn "$PWD/apps/glasses/dist" /tmp/j26web/glasses
npm run build -w @junction26/glasses
node scripts/glasses-gateway.mjs 8095 &
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8095     # prints https://<random>.trycloudflare.com
AUTHORING_MODELS=fake:demo WEB_ROOT=/tmp/j26web PUBLIC_ORIGIN=https://<random>.trycloudflare.com npm run dev:api
```

Install on the glasses with `fb-viewapp://web_app_deep_link?appName=Applets&appUrl=<url>/glasses/`
(as a QR code or a tapped link on the phone), or add the URL manually in the
Meta AI app. Get a pairing code from the authoring app's Glasses screen. Quick
tunnels are temporary: the URL changes every time cloudflared restarts.

## Running everything locally

```sh
npm run dev:db
AUTHORING_MODELS=fake:demo npm run dev:api        # terminal 1
AUTHORING_MODELS=fake:demo npm run dev:worker     # terminal 2
npm run dev -w @junction26/author                 # terminal 3 → :5173/author/
npm run dev -w @junction26/glasses                # terminal 4 → :5174/glasses/
```

Pick "Demo (canned examples, free)" in the chat's model picker to avoid
spending OpenRouter credit. The real default (Luna) needs `OPENROUTER_API_KEY`
in `.env.openrouter.local`; it has **not** been run against the applet format yet.

## Planned: images in applets (not built)

**Today:** the format (`image` views, `image` steps, `assets[]` with `uploadId`
or `data`) and the renderer (`Diagram`, re-inked for the additive display)
support images. Photos attached in the app reach the model as context only, so
it can read a photographed recipe but can't put the picture on the glasses.
Nothing fetches images from the internet. An asset with only an `uploadId`
renders "This picture isn't downloaded yet." on the glasses.

**Build order** (each step reuses the one before):

1. **Upload → applet asset.**
   - *Prompt:* list the request's image attachments with stable asset IDs
     (e.g. `img_1` = upload `<id>`, "photo of the finished joint"), and allow
     `assets[{ id, uploadId, mediaType }]`.
   - *Validation:* the worker accepts only upload IDs owned by the project
     owner, and never an inline `data` field from the model.
   - *Packaging:* `package_release` resolves every `uploadId` to bytes,
     downscales to fit 600×600 and re-encodes (WebP or PNG; open decision 4),
     dedupes by SHA-256 (`assets` table, `objectKeys.asset`), and inlines the
     result as `data` in the immutable package.
   - *Limits:* enforce a package size budget. The glasses download at about
     500 Kbps, so roughly 1 MB ≈ 16 s.
   - *Preview:* the authoring preview needs the same bytes. Either an
     authenticated asset endpoint the preview fetches, or a preview package
     built on demand.
2. **PDF ingest.** In `prepare_upload` (or a new `ingest` job), render pages
   and extract text (Poppler in the container, or pdf.js). Crop diagram
   regions and store them as derived uploads/assets. Give the model page
   images plus text, as in `experiments/openrouter-ikea-v2` (`run.py` +
   `bundle.py`). Keep source page/region references for fidelity review.
3. **Images from links.** The link import (next section) downloads the main
   images through the same SSRF-safe fetcher, stores them as uploads, and
   from there follows step 1.

## Planned: applets from web links (not built)

**Trial (2026-11-14, ~$0.02 total, `openai/gpt-6-luna` via OpenRouter).** Test
pages: Capacitor release notes published after the model's training (8.6.2,
8.6.0), checked against GitHub's API.

- Plain chat completion: the model can't fetch URLs. It said so instead of
  guessing ($0.00004).
- OpenRouter web plugin (`plugins: [{ id: 'web', max_results: 3 }]`): correct
  both times, including all 8 changes on 8.6.0, with a `url_citation`
  annotation. About $0.01 extra per request, 2–3 s. It works from search
  results, so long pages (manuals, recipes), JavaScript-rendered pages and
  pages behind a login are untested and probably come back as excerpts only.

**Design:**

1. **"Make an applet from this link"**: fetch it ourselves; don't rely on the
   model. The worker fetches the page in a preparation step (like
   `prepare_upload`), extracts readable text and the main images, stores them
   as uploads, and passes them to the model as ordinary attachments (images
   then become applet assets as in "Planned: images in applets", step 1). Reasons:
   it works with every provider, there's no per-search fee, the result is
   deterministic, and the exact source stays available for fidelity review.
   - The API accepts `urls` on a message (or `POST /v1/uploads` with a URL).
     Add a new job kind with a new migration for the CHECK constraint; see
     [jobs.md](jobs.md#adding-a-job-kind).
   - **SSRF:** the server fetches URLs that users supply, so allow only
     http(s), resolve DNS and refuse private, loopback, link-local and metadata
     addresses (re-check after redirects), cap redirects, size and time, and
     sniff the content type. PDFs go down the existing PDF path.
   - JavaScript-heavy pages may need a headless renderer or an extraction
     service (Exa / Context.dev sponsor credits) behind the same interface.
2. **Open-ended lookups ("find me a recipe for X")** use provider search.
   Add an optional `webSearch` capability and request field to
   `packages/model`. The OpenRouter provider maps it to the web plugin; other
   providers report it unsupported. Turn it on per model, record the search
   cost in job usage, and keep the citations so the authoring app can show
   sources.

## Known gaps (next)

- Real sign-in (open decision 1); `POST /v1/projects/:id/reviews` so data-loss
  acceptance is enforced server-side.
- Images in applets and PDF ingest: see "Planned: images in applets".
- The API's `POST …/revisions` still uses the interim definition check; switch
  it to `validateDefinition` (tests post minimal definitions today).
- Measured fit at publish time (headless render at 600/480); today the fit guard
  catches overflow on the device/preview only.
- Hardware verification: WebMCP via Meta AI, IndexedDB persistence, band focus.

## Real-model source pipeline (2026-11-14)

Managed generation now prepares PDF pages and images, accepts text/Markdown/CSV/JSON/HTML/Word sources, reads public links, searches source material and Commons images, and crops known diagrams. Referenced image bytes are resolved server-side into revision definitions and offline packages. Generated candidates pass canonical headless-Chromium fit checks with bounded repair. See [model-pipeline.md](model-pipeline.md), [paid evidence](model-pipeline-results.md), and [adjacent follow-ups](model-pipeline-followups.md). These checks are local desktop/backend evidence, not on-device verification.

## Looping motion (2026-11-14)

Runtime `0.2.0` adds `image/gif` assets in image views and sequence image steps.
GIFs play automatically with no playback controls and bypass static diagram ink
conversion. Upload preparation preserves motion (bounded to 8 s / 96 frames /
360 px / 512 KiB per GIF), with a PNG preview for the builder. Managed generation
caps total motion at 2 MiB. Playback uses embedded offline bytes. The local
YouTube/snippet CLI and remaining automatic builder integration are documented in
[video-tutorials.md](video-tutorials.md). Video links are not yet imported by chat.

The canonical library exports `GifImage` and `GifScreen` from
`packages/glasses-ui/src/lib/gif.tsx`. `GifScreen` contains the fitted loop, an
optional essential instruction/hint and the host's guide navigation. GIF sequence
steps now display their `text` and `hint`, so stitch counts remain visible beside
the demonstration. Decode failures show a recovery message and fail generation
fit validation. `LoopingImage` remains an export alias for compatibility.
