# Basic glasses UI

A small controlled React component library built on Meta’s official
`@wearables-ui-toolkit/mrbd` (130.33.0). Includes a local example app. No model,
network client, backend, voice listener, or persistence is required to use it.

## Run and build

Requires Node 22.12+ and npm.

```sh
cd packages/glasses-ui
npm ci
npm run dev
```

Open the printed local address in Chrome with the Meta Display simulator.
Arrow keys and Enter exercise the toolkit’s directional navigation. Use the
host’s Back command to return to the examples list.

```sh
npm run typecheck
npm test
npm run build
```

`build` produces the example app in `dist/`. `build:lib` produces ESM and type
declarations in `dist-lib/`; `test` builds the library and checks content guards.
Use this private package from a workspace or local package dependency. Import
`@junction26/glasses-ui/styles.css` once in the host. No CDN fonts or images are
introduced by this library; the toolkit ships its styling and fonts in the app.

## Components

| Component | Purpose | Contract |
| --- | --- | --- |
| `GlassesRoot` | Toolkit app/focus provider | Mount once, inside the host navigation provider |
| `ContentScreen` | A short content page | One static scroll owner, optional bottom actions |
| `TextBlock` | Instruction or explanation | Optional label and supporting hint |
| `ValueReadout` | One labeled value | Deliberately uses normal readable toolkit text |
| `InstructionScreen` | One step at a time | One-based progress; caller owns step and actions |
| `ChoiceScreen` | Open or select an item | Full page; controlled selection and stable IDs |
| `ChecklistScreen` | Toggle checklist items | Full page; controlled checked state |
| `ActionBar` | Up to two primary actions | Owned by ContentScreen; stable capability IDs |

Do not put ChoiceScreen or ChecklistScreen inside ContentScreen. Avoid putting
interactive toolkit controls inside TextBlock or adding another vertical scroll
region. Compose one focused task per screen. ContentScreen’s children are for
short static content; it cannot automatically prove that an arbitrary React tree
is readable or correctly structured.

```tsx
import { InstructionScreen } from '@junction26/glasses-ui';
import '@junction26/glasses-ui/styles.css';

<InstructionScreen
  title="First chain"
  step={2}
  total={8}
  text="Yarn over, then pull through the loop on your hook."
  actions={[{ id: 'guide.next', label: 'Next', onActivate: nextStep }]}
/>
```

The example in `src/main.tsx` shows the official router provider and retained
page transitions. Keep domain state above those transitions. The demo retains
state across navigation, but resets on reload; the library never owns or deletes
applet data. Gesture callbacks can call the same domain actions as a future
voice registry. Merely giving an action an ID does not register a WebMCP tool.

## Display and authoring constraints

Target: Meta Ray-Ban Display’s 600×600 surface. Product layout fills the available
parent rather than fixing a 600px canvas. Typography, material, colors, spacing,
and control geometry come from the toolkit. No tiny web-dashboard typography,
custom motion, dense grids, or decorative assets. The static content can scroll
using directional input; primary actions remain docked outside its viewport.

Conservative initial authoring budgets are exported as `COPY_LIMITS`:

- Page title: 32 Unicode code points.
- Label or action text: 28; supporting hint: 72.
- Instruction body: 180; short readout: 12.
- At most two primary actions, 20 items per list (the list scrolls).

These are our starting heuristics, **not hardware fit guarantees**. Language,
word lengths, header width, focus expansion, and real backgrounds affect fit.
Components reject invalid copy, duplicate/empty IDs, and invalid step progress;
they never shorten instructions silently. `checkCopy` and `checkIds` return
structured issues for the authoring UI. Catch render errors at the applet host
boundary and keep the last valid revision visible. Validate generated data
against a schema before rendering; these TypeScript components are not an
untrusted JSON parser or a complete applet DSL.

## Local SDK context and verification

The earlier SDK setup lives at
`/home/vitopalmieri/.t3/scratch/2026-11-13-can-you-set-up-the-08528f2a`.
That thread set up an Android Device Access Toolkit sample and installed the
Meta Display simulator in Chrome. This package uses the separate web UI toolkit;
it does not depend on the Android build or copy anything from that scratch app.

Verified: TypeScript, library build, production demo build, content guard tests,
and Meta’s static structure validator. The production build bundles the toolkit;
it currently emits a chunk-size advisory. Ship/cache that app shell once rather
than transferring it with each applet definition. Offline package caching itself
is still a host-runtime responsibility.

Not yet verified: simulator rendering, D-pad focus traversal, real glasses
readability, Android WebView behavior, neural band, and voice integration. Check
all screens against bright/complex backgrounds, both scroll boundaries, and a
second viewport before treating this as device-ready.
