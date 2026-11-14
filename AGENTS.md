# Agent guide: Junction26

Personal, AI-generated applets for **Meta Ray-Ban Display** glasses. Users
describe or upload what they need on a phone. A model generates a constrained
applet definition. The glasses web app runs it offline, controlled by the Neural
Band and by "Hey Meta" voice through WebMCP.

## Read first

1. [docs/product-spec.md](docs/product-spec.md): what and why, every owner decision.
2. [docs/implementation-plan.md](docs/implementation-plan.md): current state, applet format draft, milestones.
3. [docs/backend-architecture.md](docs/backend-architecture.md): contracts, data model, flows.
4. [docs/glasses-platform.md](docs/glasses-platform.md): verified Meta platform facts (WebMCP, limits, install).
5. [docs/infrastructure-setup.md](docs/infrastructure-setup.md): provisioning, env vars, deploy, local dev.
6. [docs/authoring-instructions.md](docs/authoring-instructions.md): policy given to the authoring model.
7. [docs/experiments.md](docs/experiments.md): what the trials proved.

## Commands

```sh
npm ci                     # root; npm workspaces (packages/*, experiments/*/app)
npm run build              # every workspace
npm test                   # unit tests in every workspace
(cd packages/glasses-ui && npx playwright test)                 # browser tests (Chrome)
(cd experiments/openrouter-ikea-v2/app && npx vite --host 127.0.0.1 --port 4182)   # live demo
```

Requires Node ≥22.12 (26 LTS recommended) and Google Chrome at
`/usr/bin/google-chrome-stable` for Playwright.

## Rules

- **No scrolling or panning on the glasses**, ever. Split into pages. Overflow
  must surface as the fit-guard error, never be clipped or scrollable.
- **Additive display**: black is transparent, nothing can darken the world.
  Don't add blur, scrims or dark panels for readability. Use bright, heavy,
  large content. Check in the Chrome simulator with Background Blur 0.
- `packages/glasses-ui` is the canonical component library. Experiment
  `src/lib` folders are frozen snapshots (the v2 demo copy is kept in sync while
  it's the live demo).
- Views, state and actions are separate. Never let a layout change delete user data.
- Secrets live only in git-ignored `.env.*.local` files and runtime secrets.
  Never put keys in frontend code, packages, logs or commits.
- Browsers never talk to Verda (no CORS). Route object traffic through the API.
- `experiments/*/run.py` spends real money; never re-run over recorded evidence.
- Don't claim glasses behavior (WebMCP, storage, readability) is verified
  unless it was tested on the device. Say "simulator" or "unverified".
- When copying files into a folder Vite is watching, write to a temp file and
  `mv` it, or Vite may cache a half-written module.
