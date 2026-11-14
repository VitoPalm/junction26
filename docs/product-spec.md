# Product specification

Status: agreed direction as of 2026-11-14 (Junction 2026, Meta challenge).
Sources: the founding design conversation between the project owner and Codex,
plus the trials in `experiments/`. This document is the product source of truth.
Where it and other docs disagree, fix the other doc.

## One-sentence product

**Describe the small tool you need right now; we generate it as an applet for
your Meta Ray-Ban Display glasses, and you operate it hands-free.**

Pitch lines that were agreed on along the way:

- "Bring your tutorial. Keep your hands on what you're making."
- "Bring a tutorial, pattern, or manual. Get a hands-free guide that keeps your
  place, shows your next action, and explains things when you get stuck."
- "Describe the tool you need right now on your phone or assistant. Open it on
  your glasses and operate it hands-free."

Scope clarification (2026-11-14): creation and definition/layout edits happen
on the phone/laptop authoring client or in a connected assistant. The glasses
operate downloaded applets; on-glasses authoring is outside the current scope.

## Challenge context

- Junction 2026, **Meta challenge**: how everyday people can use Meta glasses to
  improve what they do, and how to get normal people to use them.
- Hardware: **Meta Ray-Ban Display (MRBD)** with display access, plus the Meta
  **Neural Band** (EMG wristband). Not Ray-Ban Meta Gen 2. Gen 2 has no display.
- The team is small and time is short. Every decision below favors what can
  actually be built and demoed during the hackathon, while keeping the
  foundations robust and scalable (an explicit owner requirement).

## Who it is for

- **One wearer.** The applet is personal. No shared sessions, multiplayer,
  shared game mechanics, or syncing with other people. Assume the wearer is the
  only person at the table with glasses (multi-glasses scenarios are "distant
  future").
- **Normal, non-technical people** ("normies") first. Ease of use beats power.
  The owner stressed this repeatedly: *"I really wanna make it easy for users,
  can't stress this enough."*
- Advanced users can bring their own model or assistant (see Authoring).

## Core use cases

Two interaction models share one engine:

1. **Procedures (guides):** follow a sequence while your hands are busy:
   assembly manuals (the IKEA TROTTEN desk was the test case), crochet patterns,
   cooking, repair or maintenance work. The value is **keeping your place**:
   current step, what's done, recovering after an interruption, going back fast.
2. **Companions (stateful dashboards):** e.g. a D&D character sheet: health,
   inventory, spell slots, changed by voice or band while playing.

Hands-busy and hands-dirty situations (cooking, building, repairing machinery)
are the core reason to use glasses at all. Input from company schematics,
manuals, documentation and videos was in the original idea; treat complex
industrial machinery as a later expansion because of its verification burden.

Motion tutorials (owner direction, 2026-11-14): prioritize YouTube links for
crochet and dance demonstrations. The builder selects meaningful short source
intervals and crops; the glasses show automatically looping GIFs, with no playback
controls. Ordinary guide navigation keeps the wearer's place. GIF components
and a local extraction prototype exist; automatic YouTube authoring remains
planned. Details: [video-tutorials.md](video-tutorials.md).

### Explicitly out of scope

- **Dice rolling.** Rejected. The reason is *not* "dice are fun": **a roll shown
  only on the wearer's private display can't be verified by anyone else at the
  table**. General rule: *keep personal information in the glasses; keep shared
  outcomes visible to the group.*
- Multiplayer, shared state, external account sync, collaboration between users.
- Syncing with external sources (calendars, game platforms...). Everything is
  for one user at one point in time.
- Arbitrary generated code. Applets are data interpreted by our runtime.

## User experience

### Authoring client (phone, with a laptop companion)

- **Home is a library, not a chat.** It mirrors the glasses: a list of the
  user's existing applets plus a **big plus button**. (On the glasses you only
  see existing applets, never a create button.)
- **Plus opens the authoring chat.** Users describe what they want, attach files
  (PDFs, images, manuals, later URLs and videos), and refine from simple prompts.
- **First-run popup** explains in plain words what's possible, in the context of
  the models we use, so the assistant can also tell users when something is
  impossible. The same machine-readable capability catalog that constrains
  generation drives this explanation.
- **Preview before publishing.** The preview uses the same validation and
  action semantics as the glasses, with preview state kept apart from real
  user state.
- **Edits at any time, even after the wearer started using the applet.**
- **Change review (data-loss protection):**
  - Models are instructed not to delete earlier information unless the user
    really wants that. The protection is enforced by the program, not by trust in
    the model.
  - We wait until the model *finishes* the whole revision before comparing it to
    the previous one. If the model just moved information elsewhere, nothing was
    lost and we don't bother the user.
  - If something the user could see or edit becomes inaccessible or deleted
    (e.g. a card holding the inventory), the program detects it. AI writes a
    short human explanation, e.g. *"this way you'll lose your character sheet
    inventory"*, not *"card 22 will be removed"*.
  - Show a **preview of the element being removed**, so the loss is visible.
    Several losses can be reviewed together and skipped through quickly when
    they were intended.
  - If the user did not want it, they say how to keep it or why the model
    misunderstood; the model runs again with that feedback.
  - Technical rule behind this: **views, state and actions have separate
    identities.** Removing an inventory *card* doesn't delete the *inventory*.
    Details in [backend architecture](backend-architecture.md#design-and-data-have-separate-lifecycles).
- **Publish** sends a validated, immutable revision to the glasses.

### Glasses web app

- Opens on a **home screen with the latest 3 projects and an "Older" entry**,
  navigable with Neural Band gestures (D-pad focus + pinch) or voice.
- Pick one to open it. It runs entirely locally from the downloaded package.
- **No scrolling or panning, in either axis, ever.** Content that doesn't fit is
  split into discrete pages with Previous/Next. Overflow is an authoring error,
  never a scroll area or silent clipping. (Owner: *"I really don't like
  scrolling, it's really bad for something that needs to run w no hands."*)
- **Visual-first.** If images alone explain a step, show only the image. No
  narration of what the picture already shows, no decorative headings.
- **Identifiers only with context.** A part code is useful only with a
  description or a directly associated image; otherwise omit it.
- Readable on an **additive display** (it can only add light; black is
  transparent). Bright, heavy, large content. Blur/dark panels don't help. See
  [glasses platform](glasses-platform.md#additive-display).
- Remembers where you were (stable step/state IDs), across closes and
  republished revisions.

### Input: voice and band converge on one action registry

- **"Hey Meta, …" voice control via WebMCP.** While our applet is open, it
  registers its actions as tools on `document.modelContext`. Meta AI listens,
  interprets the request and calls our tool. **We run no STT and no
  command-interpreter model of our own.** Example: *"Hey Meta, increase my
  maximum health by four"* → `dnd_adjust_max_health(delta=4)`.
  This is the intended integration, currently in Meta developer preview and
  unverified on our hardware/account. Every action remains manually reachable.
  See [WebMCP assumption audit](webmcp-audit.md).
- **Neural Band:** D-pad focus navigation plus pinch-to-select, activating the
  focused control's `onClick`. Same actions as voice, no model call.
- The generator picks a **primary action and focus order** per applet (crochet:
  "completed repetition" focused, so a pinch increments the counter; cooking:
  "next step"). Navigation/select/back stay consistent across applets so habits
  carry over.
- Nice interaction to demo: set a value by voice, then use silently with the
  band (*"Set my row counter to twelve"* → subsequent pinches increment it).
- Text input fallback: tapping a text field opens Meta's dictation/handwriting
  composer (needs user activation).

### Demo storyline (suggested)

Describe a tool on the phone or in a connected assistant → preview and publish
→ open on glasses → use it quietly with the band → update a value by voice
→ close and reopen, state preserved. Applet definition changes happen in the
authoring surface, followed by publish and explicit sync.
For guides: upload a manual → preview → glasses show one step at a time →
recover from confusion without putting the work down.

## Authoring and model strategy

- Applet generation needs a capable model. **Operating** an applet doesn't:
  Meta AI does voice, ordinary code does actions.
- **Managed default:** `openai/gpt-6-luna` via OpenRouter (funded key, $17 cap,
  expires 2026-11-21). Keep the model configurable behind an adapter.
- **Bring your own assistant:** expose authoring tools (an MCP server) so users
  can make applets from ChatGPT/Codex, Claude, or a local model, at no cost to
  us. Offer guides for the common ones. Possibly subsidize the first applet with
  sponsor credits, then users either pay or connect their own assistant.
- **Model picker** for advanced users with a sensible default for everyone else.
- Generation must be easy enough with standardized components that a cheap
  model succeeds; the component catalog and schema exist to make that true.
- OpenAI "Codex credits" from Junction are **not API credits**. They can only
  power the personal-assistant path, never our hosted worker. Gemini and
  Anthropic credit applications are pending.

## Connectivity principle

Glasses internet is **very slow** (owner-tested; Meta documents ~500 Kbps down,
~150 ms RTT). Use the network only for what needs it:

- Meta AI voice interpretation (Meta's side, unavoidable).
- Creating or editing applets (phone/laptop, not glasses).
- Downloading new or changed applet packages (explicit sync).
- Occasional, batched state backup.

Rendering, band input, action execution, navigation and saving progress are all
local. Opening an already downloaded applet or changing a value makes **no
network request**. Shared fonts/icons/components ship with the app; only
applet-specific assets ship in the applet package.

## Decision log (with rejected alternatives)

| Decision | Chosen | Rejected and why |
| --- | --- | --- |
| Product shape | General generator of simple personal applets | Crochet-only guide (too narrow, owner wanted "any simple UI") |
| Glasses runtime | **One web app on the glasses** that interprets applet packages | Native phone companion via Device Access Toolkit (iOS background speech is best-effort/undocumented; too risky for the time available). Owner may prototype both, but web is the plan of record |
| Voice | **Meta AI + WebMCP** ("Hey Meta") | Own STT plus a small cloud interpreter model (Gemma/Muse class). No longer needed |
| Small interpreter model | None | Was planned for natural-language → typed action. WebMCP made it redundant |
| Applet format | Constrained JSON data + fixed runtime | Generated React/JS per applet; an actual MCP server per applet |
| Display format | Semantic content (steps, values, actions) rendered by our components | Pixel layouts ("rounded card at x,y") |
| Scrolling | Prohibited | Scroll views (bad hands-free) |
| Hosting | Aiven Runtime | Verda VM (more ops), Modal (unneeded) |
| Database | Aiven PostgreSQL | SQLite + local files (not robust/scalable enough for the owner's bar) |
| Object storage | Verda S3 bucket (already provisioned) | IronShard, Cloudinary (unneeded for now) |
| Authoring model | GPT-6 Luna via OpenRouter | Direct OpenAI API (no funded API credit) |
| Dice | Dropped | Private display can't show a verifiable roll |

## Sponsors and credits (Junction 2026)

| Provider | Offer | Status for us |
| --- | --- | --- |
| Meta | Glasses, toolkit, WebMCP, mentors | Core platform |
| OpenRouter | (own funds) | **In use** for authoring, $17 key cap |
| Verda | €200 credits, code `JUNCTION-2026` (needs a payment method on file to redeem) | **Redeemed** in project `Junction26`; bucket provisioned |
| Aiven | $50 signup credits, 30-day trial, no card | **Selected** for Runtime + PostgreSQL; nothing provisioned yet |
| OpenAI | $100 "Codex credits" (2,500 credit units seen) | Codex only, not API |
| Google Gemini | API credits (amount unspecified) | Applied, pending |
| Anthropic | $20 API credits per participant | Applied, pending |
| Modal | $100 compute | Not needed |
| Featherless | $50 API credits | Alternative model host |
| Cloudinary | Free tier | Optional image optimization |
| Exa / Context.dev | $50 per participant / 50k credits per team | Later: importing tutorial URLs |
| CRACI | €1,000 per team CI/compute (invite code) | Not needed |
| IronShard | S3-compatible buckets | Not needed |

The official roster was at <https://2026.hackjunction.com/#partners> and offers at
<https://hackjunction.app/participate/45/hackerpacks> (login required).
