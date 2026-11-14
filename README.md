<img src="assets/icon.svg" width="64" height="64" alt="">

# Junction26

**Describe the small tool you need right now; get it as an applet on your Meta
Ray-Ban Display glasses, and use it hands-free.** Built for the Junction 2026
Meta challenge.

- Upload a manual or pattern, or just describe a tool (a D&D character tracker,
  a crochet row counter). A model generates a constrained applet definition.
- The glasses web app runs it **offline**: one fixed page at a time, no scrolling.
  You control it with the Neural Band or by saying **"Hey Meta, …"** (WebMCP).
- Edit it any time. Preview uses separate state; change review flags removals.
  Server-side review enforcement is still incomplete (see [known gaps](docs/apps.md#known-gaps-next)).

## Status

The MVP authoring and glasses apps, API, durable worker, PostgreSQL schema,
storage, publishing, pairing and state backup are built and tested locally.
Managed generation supports PDFs, images, documents and public links, with
canonical renderer fit checks; real Luna runs are recorded in the
[pipeline evidence](docs/model-pipeline-results.md). Web Clerk sign-in and
scoped assistant MCP OAuth are implemented; native OAuth still needs end-to-end
verification. Aiven resources are provisioned; provisioning alone does not
establish a healthy deployment. Glasses voice has limited hardware evidence,
while storage, offline launch and readability still need device checks. See
[apps](docs/apps.md), [implementation plan](docs/implementation-plan.md) and
[WebMCP evidence](docs/webmcp-audit.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [Product spec](docs/product-spec.md) | Vision, users, UX, every decision with rejected alternatives, sponsors |
| [Implementation plan](docs/implementation-plan.md) | Current state, repository layout, historical format draft, milestones, remaining decisions |
| [Managed pipeline](docs/model-pipeline.md) | Supported sources, source tools, fit checks, limits and local prerequisites |
| [Model providers](docs/model-providers.md) | Provider configuration and verification limits |
| [Authentication](docs/authentication-plan.md) | Web accounts, native OAuth and deployment configuration |
| [Assistant MCP](docs/assistant-mcp.md) | Scoped external-assistant draft authoring |
| [Voice notes](docs/voice-notes.md) | Phone recording/transcription anchored to glasses pages |
| [Backend architecture](docs/backend-architecture.md) | Contracts, data model, jobs, publishing, offline execution, sync, API |
| [Glasses platform](docs/glasses-platform.md) | Verified Meta Ray-Ban Display facts: limits, additive display, WebMCP, install |
| [Apps](docs/apps.md) | Authoring app (web/iOS/Android), glasses app, applet format, swappable models, running it all |
| [Backend development](docs/backend-development.md) | Run, test and change the API and worker locally |
| [API reference](docs/api.md) | Sessions, errors, idempotency, every endpoint, sync and backup protocol |
| [Background jobs](docs/jobs.md) | Job lifecycle, leases, retries, handlers, release package format |
| [Database](docs/database.md) | Tables, invariants, migrations |
| [Infrastructure setup](docs/infrastructure-setup.md) | Accounts, env vars, Verda, Aiven PostgreSQL + Runtime, OpenRouter, local dev, device setup, costs |
| [Verda setup](docs/verda.md) | The provisioned bucket |
| [Authoring instructions](docs/authoring-instructions.md) | Policy given to the authoring model |
| [Experiments](docs/experiments.md) | Luna/OpenRouter trials, costs, lessons |
| [Glasses UI library](packages/glasses-ui/README.md) | Components, rules, additive-display ink |
| [AGENTS.md](AGENTS.md) | Rules and commands for coding agents |

## Quick start

```sh
npm ci
npm run build
npm run dev:db  # required for database-backed tests; needs podman/docker
npm test
cd experiments/openrouter-ikea-v2/app && npx vite --host 127.0.0.1 --port 4182
```

For the full authoring/API/glasses loop, use the
[local development guide](docs/backend-development.md#first-run) and
[app commands](docs/apps.md#running-everything-locally). The command above opens
the frozen IKEA experiment demo.

Open the URL in Chrome with the
[Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll)
enabled, and set Background Blur to 0. Use the arrow keys, Enter and Esc.

## Repository

```text
docs/                 specs and setup guides
apps/api/             HTTP API (Hono): projects, uploads, revisions, publishing, sync, pairing, state
apps/worker/          durable PostgreSQL job runner: generation, upload prep, packaging
apps/glasses/         Meta Ray-Ban Display web app (offline library, applet runtime, WebMCP, sync)
apps/author/          authoring app: web + Capacitor iOS/Android shells
packages/applet-*     applet format (schema, validation, prompt), runtime, React renderer
apps/assistant-mcp/   shared external-assistant authoring tools (stdio and API /mcp)
packages/model/       model adapters (OpenRouter, compatible endpoints, Anthropic, Gemini, fake)
packages/db/          SQL migrations + typed queries
packages/storage/     object storage adapter (Verda S3, fs, memory)
packages/server-common/ config, logging, shutdown
packages/glasses-ui/  canonical display component library (@wearables-ui-toolkit/mrbd 130.33.0)
experiments/          frozen authoring trials with prompts, outputs, evaluations, demo apps
.env.*.example        credential templates (real values live in git-ignored .env.*.local)
```

Created in [T3 Code](https://t3.codes).
