# OpenRouter IKEA authoring trial

A local simulation of an app upload and backend generation worker. It calls the real funded OpenRouter API; it does not use Codex or another coding-agent harness for generation. No live Aiven/Verda deployment or app upload UI is implied.

## Result

One request to `openai/gpt-6-luna` with medium reasoning returned complete, schema-valid data without retries or model corrections.

- API round-trip: 48.33 seconds; PDF preparation and packaging are additional local work.
- Reported request cost: $0.007120675 (0.712 cents).
- Tokens: 36,654 input; 5,078 completion, including 3,206 reasoning tokens, as reported by OpenRouter.
- Key budget after the call: $16.992879325 remaining of its $17 cap.
- Content: 10 shared screens plus 4 branch screens for each of two desk sizes; 18 distinct content screens, 14 per selected guide.
- JSON definition: 9,169 bytes. Packaged diagram assets: 878,647 bytes in total; these are downloaded once with the guide, not on each step.
- Build and TypeScript: passed. Six tests passed: three baseline content guards plus three host progress/navigation tests.

## Flow

1. Copy the downloaded PDF to a local upload directory, representing a backend-owned upload.
2. Poppler renders all 16 pages with a maximum dimension of 1,600 pixels and extracts per-page text. No manual page selection or assembly transcription.
3. A single server-side Chat Completions request sends the normal user request, generic authoring policy, component/data contract, page text and images, and a strict output schema. No prior candidate or evaluator findings are included.
4. Require parameter support, disable provider fallbacks, cap output at 20,000 tokens; make no automatic retries. Actual provider/model metadata and usage are saved.
5. Validate the JSON locally: shape, field types, copy budgets, stable IDs and crop bounds.
6. Deterministically crop the model-selected source regions, invert dark-on-white line art for the additive display, and package local assets. A fixed React host renders the JSON through the existing components and implements Previous/Next/Finish and localStorage resume by stable step ID.

The image transformation and renderer are infrastructure written by the evaluator, not capabilities independently implemented by Luna. This is intentionally a **content-generation test inside a supplied runtime**, rather than a test of autonomous code generation. It is also instruction-guide-specific; it is not yet the universal applet schema.

## Quality review: candidate not accepted as verified instructions

The model did not receive feedback or a correction turn. `candidate.json` preserves its exact parsed content. Structural validity is not source fidelity.

- Source page 4, printed step 1: the text again describes building complete end frames rather than the illustrated operation of inserting bolts into the foot rail. The completed assembly is an inset showing the repeated target result.
- Source page 8, printed step 7: text mentions the two fasteners tightened with key 100049 but omits the second pair explicitly shown being tightened with key 108490. The crop does contain both operations, so drawing and prose are inconsistent in completeness.
- Source page 7, printed step 6: text calls 114254 "toothed washers"; the source inventory and close-up show a serrated/flanged nut. The instruction also fails to name the hex-key operation shown alongside the wrench.
- Source page 2: the added hint "Do not stand on the panels" is not depicted by the supplied pictograms. It is an unsupported addition rather than a faithful translation.
- Preparation is included, but all part numbers and quantities are packed into one dense body paragraph. This passes the character budget while violating the intended easy-to-read hierarchy. Character limits alone do not guarantee readable content.
- Crops are local and display-polarity adapted, but selected regions can include a sliver of the next printed step. Several remain large, detailed drawings without zoom or focused subviews. Two generated crops were inspected directly; no claim of exhaustive crop review or on-glasses legibility is made.

This supports the feasibility of inexpensive, constrained generation and packaging. It does not establish trustworthy interpretation of diagram-heavy manuals. Additional source-content validation and display inspection remain necessary. No simulator, browser interaction, real glasses, band, voice, service worker cache, S3, queue, database, or hosted authentication was tested.

## Files and reproduction

- `system-prompt.txt`, `user-prompt.txt`, `schema.json`: complete authoring instructions and contract.
- `request.json`: request with embedded image bytes replaced by references; `input-manifest.json` gives original image paths and SHA-256 hashes. It contains no credentials.
- `response.json`, `request-metrics.json`, `budget-before.json`, `budget-after.json`: API evidence; no request authentication headers saved.
- `candidate.json`, `validation.json`: unchanged generated data and local validation results.
- `run.py`: worker simulation. Uses `.env.openrouter.local` only server-side. **Makes a paid API request.** Archive this experiment before deliberately running another generation.
- `bundle.py`: deterministic packaging; no API call.
- `app/`: fixed React host with local diagrams and generated data. Run `npm run dev` here to open it in the Meta simulator. Run `npm run build` and `npm test` for checks.

Python requirements: requests, Pillow, and Poppler (`pdftoppm`, `pdftotext`). The app is an npm workspace: run `npm ci` at the repository root. Browser history fallback is required when deploying the app under an HTTP host.

## Subsequent renderer change: fixed pages

After the recorded first-pass test, the user prohibited scrolling throughout the
library. The current demo uses the updated shared components and a deterministic
page adapter: text is split without dropping words, hints remain in the reading
sequence, and diagrams get separate fitted pages. Saved original step IDs
migrate to the first corresponding text page. The API candidate, prompts, usage
and source-fidelity findings above remain unchanged. No extra API call was made.
