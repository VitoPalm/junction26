<img src="assets/icon.svg" width="64" height="64" alt="">

# Junction26

**Describe the small tool you need right now; get it as an applet on your Meta
Ray-Ban Display glasses, and use it hands-free.** Built for the Junction 2026
Meta challenge.

- Upload a manual or pattern, or just describe a tool (a D&D character tracker,
  a crochet row counter). A model generates a constrained applet definition.
- The glasses web app runs it **offline**: one fixed page at a time, no scrolling.
  You control it with the Neural Band or by saying **"Hey Meta, …"** (WebMCP).
- Edit it any time. The system detects anything an edit would remove and asks
  before data is lost.

## Status

Design agreed and documented. The glasses component library and the authoring
pipeline proof (PDF → GPT-6 Luna via OpenRouter → validated JSON → rendered
guide, ~$0.007 per manual) exist. Backend services, the glasses app shell and the
authoring client aren't built yet. See the [implementation plan](docs/implementation-plan.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [Product spec](docs/product-spec.md) | Vision, users, UX, every decision with rejected alternatives, sponsors |
| [Implementation plan](docs/implementation-plan.md) | Current state, target layout, applet format v1 draft, milestones, open decisions |
| [Backend architecture](docs/backend-architecture.md) | Contracts, data model, jobs, publishing, offline execution, sync, API |
| [Glasses platform](docs/glasses-platform.md) | Verified Meta Ray-Ban Display facts: limits, additive display, WebMCP, install |
| [Infrastructure setup](docs/infrastructure-setup.md) | Accounts, env vars, Verda, Aiven PostgreSQL + Runtime, OpenRouter, local dev, device setup, costs |
| [Verda setup](docs/verda.md) | The provisioned bucket |
| [Authoring instructions](docs/authoring-instructions.md) | Policy given to the authoring model |
| [Experiments](docs/experiments.md) | Luna/OpenRouter trials, costs, lessons |
| [Glasses UI library](packages/glasses-ui/README.md) | Components, rules, additive-display ink |
| [AGENTS.md](AGENTS.md) | Rules and commands for coding agents |

## Quick start

```sh
npm ci && npm run build && npm test
cd experiments/openrouter-ikea-v2/app && npx vite --host 127.0.0.1 --port 4182
```

Open the URL in Chrome with the
[Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll)
enabled, and set Background Blur to 0. Use the arrow keys, Enter and Esc.

## Repository

```text
docs/                 specs and setup guides
packages/glasses-ui/  canonical display component library (@wearables-ui-toolkit/mrbd 130.33.0)
experiments/          frozen authoring trials with prompts, outputs, evaluations, demo apps
.env.*.example        credential templates (real values live in git-ignored .env.*.local)
```

Created in [T3 Code](https://t3.codes).
