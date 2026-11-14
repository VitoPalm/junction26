# Basic glasses UI

A controlled React component library built on Meta’s official
`@wearables-ui-toolkit/mrbd` (130.33.0). **Scrolling is prohibited, in both axes.**
Every task is a discrete page navigated by actions. No gesture should be needed
to uncover the rest of an instruction, choice, or diagram.

## Run and build

Requires Node 22.12+ (26 LTS recommended) and npm. The repository uses npm
workspaces, so install from the repository root.

```sh
npm ci                     # at the repository root
cd packages/glasses-ui
npm run dev
npm run build
npm test
npx playwright test        # browser checks; needs Google Chrome
```

Dependencies (2026-11-14, all current): `@wearables-ui-toolkit/mrbd` 130.33.0,
React 19.3.1, react-router-dom 7.18.5, Vite 8.3.8, TypeScript 7.0.2.

Open the local address in Chrome with the Meta Display simulator. Arrow keys and
Enter exercise directional focus and activation. The host Back command returns
from the examples. The checklist demonstrates multiple discrete pages.

`build` produces the example app in `dist/`. `build:lib` produces ESM and type
declarations in `dist-lib/`. Use this private package from a workspace or local
dependency and import `@junction26/glasses-ui/styles.css` once. Assets and toolkit
fonts ship with the app; no CDN dependencies are added.

## Components

| Component | Purpose | Contract |
| --- | --- | --- |
| `GlassesRoot` | App/focus provider | Mount once, inside the host navigation provider |
| `ContentScreen` | Fixed content page | No scroll owner; measured content-fit guard |
| `TextBlock` | One short thought | Label, body and optional supporting hint |
| `ValueReadout` | One labeled value | Normal readable toolkit typography |
| `InstructionScreen` | One instruction page | Caller owns progress and actions |
| `Diagram` | One source region | Re-rendered for the display (crop, thicken, de-speck, brighten) and fitted whole |
| `ChoiceScreen` | Open/select an item | Up to three choices per discrete page |
| `ChecklistScreen` | Controlled toggles | Up to three items per discrete page |
| `ActionBar` | Up to two primary actions | Non-scrolling ButtonGroup; never a ButtonRail |

The page owns an optional title, a fixed content area and an action dock.
Image-only pages may omit all visible headings and captions. Add text only when
it contributes useful information; see docs/authoring-instructions.md at the
repository root.
No ScrollView, VerticalList, horizontal rail, nested overflow:auto, pan region,
or text truncation is allowed. Fit errors replace the invalid page content with
an explicit instruction to split it in the editor. Clipping is only an input
barrier; ResizeObserver checks the authored content dimensions so an overloaded
page is reported rather than silently hidden. The guard is not an authoring
substitute or a universal validator of arbitrary nested React children.

A `Diagram` may share a ContentScreen with one short `TextBlock` (the
instruction line under the picture); the diagram takes the remaining height.
A dense drawing that needs the full page, or text that exceeds the body limit,
belongs on its own page. Split complex drawings into meaningful source-region/detail
pages; never shrink type to squeeze a diagram in. Fitting the full image avoids
scrolling but does not prove that its small labels are legible on hardware.

## Authoring and state

Starting copy budgets in `COPY_LIMITS`: title 32 Unicode code points, labels 28,
body 120, hint 48, readout 12, at most two primary actions. These are heuristics,
not fit guarantees. `paginateText` splits longer copy without dropping words;
`pageItems` slices collections. The measured fit guard catches geometry that
character counts cannot. Oversized content must become additional pages.

```tsx
import { ContentScreen, Diagram } from '@junction26/glasses-ui';
import '@junction26/glasses-ui/styles.css';

<ContentScreen title="Fit the joint" actions={[
  { id: 'guide.previous', label: 'Previous', onActivate: previous },
  { id: 'guide.next', label: 'Next', onActivate: next },
]}>
  <Diagram src="/guide/joint.png" alt="The two fasteners and their holes" />
</ContentScreen>
```

Use stable content and action IDs. Domain state lives outside route transitions;
page changes must not delete applet data. The library neither provides durable
storage nor registers WebMCP tools. A voice adapter should invoke the same
Previous/Next/select/toggle handlers as directional controls. Do not pass
unvalidated model JSON directly into arbitrary React; the host owns its schema,
last-valid-revision policy and persistence.

## Checks

`npm test` verifies content guards, lossless text pagination and collection
pagination. `npm run test:browser` uses headless Chrome and a local test server.
The IKEA integration cases expect the running demo at http://127.0.0.1:4180/.
Tests cover page fit, wheel input having no scroll effect, collection page
changes, and explicit overflow errors. The baseline suite traverses the IKEA
pages at 600×600 and samples text/diagram pages at 480×480.

The original SDK setup is in the separate scratch project
`/home/vitopalmieri/.t3/scratch/2026-11-13-can-you-set-up-the-08528f2a`.
This library uses the web toolkit, not the Android Device Access Toolkit.
Real glasses readability, band input and voice remain unverified. The toolkit's
scroll-oriented static skeleton validator is no longer the acceptance contract:
our product explicitly requires fixed pages instead.

## Additive display readability

The lens adds light to the world; it cannot darken or blur it. The Chrome
simulator models this with `mix-blend-mode: screen`. Plates, backdrop blur and
dark panels therefore do nothing for legibility and only wash out our own
content. Every component is designed around emitted light instead:

- Text is bright white and heavy: titles HEADING2, bodies BODY1_EMPHASIZED,
  values NUMERAL2 bold, eyebrows in a high-luminance accent (`--g-ink-accent`;
  toolkit blue is too dim on an additive display). Toolkit button labels are
  bolded.
- `Diagram` re-renders each source image for the exact size it is shown at
  (`inkify` in `src/lib/ink.ts`). It normalises polarity to light-on-black,
  drops marks smaller than ~4.5 display px (unreadable part codes and specks),
  crops empty margins, dilates strokes at source resolution so they land at
  ~1.7 CSS px after downscaling, and lifts antialiased edges to full white.
  Results are cached per source and size; the source shows briefly until the
  render is ready. Original assets are unchanged. `data-src` holds the source.
- Diagram pages use a tight inset so the drawing gets the whole content area.

Checked in the Chrome simulator at background blur 0 on the cafe and bridge
scenes, and in headless Chrome at 600x600 / DPR 1, screen-blended over the
simulator's own backgrounds. Very dense overviews (for example a full parts
sheet) remain small; split them into detail pages. Hardware legibility is not
yet verified.
