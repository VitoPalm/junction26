# Infrastructure setup (step by step)

How to stand up every piece of infrastructure from zero, in order. Facts were
verified against provider docs on 2026-11-14. Prices and plan names change;
re-check the linked pages before spending money.

What already exists is marked **[done]**. Everything else is **[todo]**.

## 0. Overview

```text
 Phone / laptop browser            Meta Ray-Ban Display (web app, offline-first)
 ┌──────────────────────┐          ┌───────────────────────────────────────────┐
 │ Authoring PWA        │          │ Glasses app: library + applet runtime     │
 │ chat, uploads,       │          │ IndexedDB state, SW cache, WebMCP tools   │
 │ preview, publish     │          └───────▲───────────────────────▲──────────┘
 └──────────┬───────────┘                  │ explicit sync only    │ "Hey Meta"
            │ HTTPS (same origin)          │ HTTPS (same origin)   │
 ┌──────────▼──────────────────────────────┴──────────┐    ┌──────┴──────┐
 │ Aiven Runtime: `api` app                            │    │ Meta AI      │
 │  serves /glasses/*, /author/* static + /v1/* API    │    │ (Meta cloud) │
 │  streams uploads/packages to/from Verda (no CORS)   │    └─────────────┘
 ├─────────────────────────────────────────────────────┤
 │ Aiven Runtime: `worker` app (same image, other CMD) │──► OpenRouter
 │  durable jobs: prepare upload, generate, package    │    (openai/gpt-6-luna)
 └──────────┬──────────────────────────┬───────────────┘
            │ DATABASE_URL             │ S3 API (path-style)
   ┌────────▼─────────┐       ┌────────▼─────────────────────────┐
   │ Aiven PostgreSQL │       │ Verda Object Storage (FIN-03)     │
   │ (Startup plan)   │       │ bucket junction26-applets [done]  │
   └──────────────────┘       └───────────────────────────────────┘
```

Key constraint discovered during verification: **Verda Object Storage doesn't
support CORS, bucket policies, ACLs or public buckets.** Browsers (authoring
client and glasses) therefore can't upload to or download from Verda directly,
not even with presigned URLs via `fetch`. **All object traffic goes through our
API**, which also keeps every request same-origin (no CORS anywhere).

## 1. Accounts and credentials

| Service | Account | State | Where the secret lives locally |
| --- | --- | --- | --- |
| GitHub | `VitoPalm/junction26` (private) | **[done]** | gh CLI keyring |
| OpenRouter | owner's account, ~$17.59 balance at setup | **[done]** key with $17 cap, **expires 2026-11-21 04:14 UTC** | `.env.openrouter.local` (0600, git-ignored) |
| Verda | project `Junction26`, €200 credits | **[done]** | `.env.verda.local` (0600, git-ignored) |
| Aiven | trial, $50 credits, 30 days, no card (project `vitopalm1982-7b23`) | **[done]** 2026-11-14: `j26-pg`, `api`, `worker` (see sections 3–4) | Runtime secrets only |
| Meta | Developer Mode on the glasses | **[todo]** verify on the team's device | — |

Never commit `.env*.local`. `.gitignore` allows only `*.example` files.
Templates: [`.env.openrouter.example`](../.env.openrouter.example),
[`.env.verda.example`](../.env.verda.example).

### Full environment contract for the services

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | api, worker | Injected by the Aiven service integration (full URI, includes `sslmode`) |
| `OPENROUTER_API_KEY` | api, worker | Runtime secret. Never in a frontend bundle. The api needs it for the voice bridge unless `VOICE_MODEL=fake:voice` |
| `OPENROUTER_BASE_URL` | worker | `https://openrouter.ai/api/v1` |
| `AUTHORING_MODEL` | api, worker | Default model spec, `openai/gpt-6-luna` (bare name = OpenRouter; `provider:model` otherwise). See [apps.md](apps.md#models-swappable) |
| `AUTHORING_MODELS` | api, worker | Extra specs users may pick, comma-separated (e.g. `fake:demo`) |
| `VOICE_MODEL` | api | Voice-bridge resolver, default `google/gemini-3.5-flash-lite` (needs audio input + tools); `fake:voice` is free. See [voice-fallback.md](voice-fallback.md) |
| `AUTHORING_REASONING_EFFORT` | worker | Optional `low`/`medium`/`high` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | worker | For `openai:<model>` specs (any OpenAI-compatible endpoint) |
| `CORS_ORIGINS` | api | Browser origins allowed to call `/v1` (native shells: `capacitor://localhost,https://localhost`). Dev default includes those and the Vite ports; production default is none |
| `WEB_ROOT` | api | Directory with the built `glasses/` and `author/` apps; `/app/web` in the image |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | api, worker | Verda key `junction26-backend-storage` (project-scoped: can read every bucket in the project) |
| `AWS_ENDPOINT_URL` | api, worker | `https://objects.eu-north-3.verda.storage` |
| `AWS_REGION` | api, worker | `eu-north-3` |
| `VERDA_S3_BUCKET` | api, worker | `junction26-applets` |
| `S3_FORCE_PATH_STYLE` | api, worker | `true` |
| `PORT` | api | `8080` (matches Dockerfile `EXPOSE`) |
| `SESSION_SECRET` | api | Random 32+ bytes. Signs device/session tokens |
| `PUBLIC_ORIGIN` | api | The Aiven HTTPS URL; used in QR/deep links |
| `MAX_UPLOAD_BYTES`, `GENERATION_CONCURRENCY`, `MAX_OUTPUT_TOKENS` | api, worker | Abuse and budget limits (defaults 50 MiB, 2, 16000) |
| `MAX_DEFINITION_BYTES`, `MAX_STATE_BYTES` | api | JSON size limits (defaults 512 KiB, 256 KiB) |
| `NODE_ENV` | api, worker | `production` in the image. **Refuses `AUTH_MODE=dev` and non-S3 storage** |
| `SERVICE_ROLE` | container | `api` (default), `worker` or `migrate`; read by `scripts/entrypoint.sh` |
| `MIGRATE_ON_START` | api, worker | `true` on the `api` app; migrations take an advisory lock |
| `DATABASE_CA_CERT` | api, worker | PEM of the Aiven project CA (service page → CA certificate), one line with literal `\n` separators. Required on Aiven: node-postgres treats `sslmode=require` as full verification and the project CA isn't in the system store. When set, URL `ssl*` parameters are ignored and TLS is verified against this CA |
| `MIGRATION_DATABASE_URL` | api, worker | Optional direct (non-PgBouncer) URI for migrations; defaults to `DATABASE_URL` |
| `DATABASE_POOL_MAX` | api | Connections per API process (default 10) |
| `STORAGE_DRIVER` | api, worker | `s3` (default, required in production), `fs` or `memory` for development |
| `AUTH_MODE` | api, worker config | `clerk` for real web accounts; `dev` is local-only and refused in production |
| `CLERK_ISSUER` | api, worker config | Required in Clerk mode: exact HTTPS issuer of the configured instance |
| `CLERK_AUTHORIZED_PARTIES` | api, worker config | Required in Clerk mode: comma-separated frontend origins; HTTPS in production, loopback HTTP also allowed in development. Separate from CORS |
| `CLERK_SECRET_KEY` | api, worker config | Backend-only Clerk key for signing-key retrieval; required unless `CLERK_JWT_KEY` is set |
| `CLERK_JWT_KEY` | api, worker config | Optional PEM RSA public key for networkless verification, instead of a secret key; literal `\n` separators supported. Takes precedence; rotate manually |
| `CLERK_ALLOW_DEVELOPMENT_INSTANCE` | api, worker config | Hackathon opt-in (default `false`): lets production accept a Clerk development instance (`sk_test_…`, `*.clerk.accounts.dev`). Dev auth, HTTP origins and non-S3 storage stay refused. Remove once a production Clerk instance exists |
| `VITE_CLERK_ALLOW_DEVELOPMENT` | author build | Matching build-time opt-in for a `pk_test_…` key in a release build. Set in the committed, public `apps/author/.env.production` |
| `VITE_AUTH_MODE`, `VITE_CLERK_PUBLISHABLE_KEY` | author build | `clerk` + public `pk_live_…` for release; local Vite defaults to dev login. `pk_test_…` only with the dev server. Never pass a secret key to Vite |
| `LOG_LEVEL` | api, worker | `debug`, `info` (default), `warn`, `error` |
| `WORKER_CONCURRENCY`, `WORKER_POLL_MS`, `WORKER_LEASE_MS`, `WORKER_ID` | worker | Defaults 2, 1000, 60000, generated |
| `WORKER_HEALTH_PORT` | worker | If set, serves `GET /healthz` (for hosts that need a listening port) |
| `SHUTDOWN_GRACE_MS` | api, worker | Default 20000 |

The parser is `packages/server-common/src/config.ts`. It lists every problem at
once and exits before serving anything. Local values for development live in
`.env.backend.local` (template: [`.env.backend.example`](../.env.backend.example)).

## 2. Object storage: Verda **[done]**

Already provisioned (details in [verda.md](verda.md)): bucket
`junction26-applets`, FIN-03, endpoint `https://objects.eu-north-3.verda.storage`,
region `eu-north-3`, path-style. An upload/read/delete round trip was verified.

Facts that shape the design (from <https://docs.verda.com/storage/object-storage/>,
updated 2026-10-16):

- S3-compatible (AWS SDK v3, boto3, rclone, s5cmd). **Beta.** Quota: 1 TiB,
  100k objects, 100 buckets (check Account settings → Quotas).
- **Buckets can't be created through the S3 API**: use the console or the Verda API.
- Presigned URLs work (server-to-server or for links); **no CORS, policies,
  ACLs or public access**.
- Billing is per GiB-month from the prepaid balance every 10 minutes; requests
  and egress are free. **If the balance hits zero, S3 access is suspended.**
- Maintenance was announced for FIN-03 on 2026-11-15, 19:00–22:00 UTC.

To recreate from scratch:

1. Sign up at verda.com and create project `Junction26` **before** redeeming
   credits (credits attach to the selected project). Redeem: Project →
   Billing & settings → Top-up → Credit coupon → `JUNCTION-2026`. A payment
   method must be on file first.
2. Console → Object storage → create bucket `junction26-applets` in FIN-03.
3. Create an access key, store it in `.env.verda.local` (chmod 600).
4. Smoke test (Node, AWS SDK v3, `@aws-sdk/client-s3` 3.1169.0 current):

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION, forcePathStyle: true });
const Bucket = process.env.VERDA_S3_BUCKET!, Key = 'healthcheck/smoke.txt';
await s3.send(new PutObjectCommand({ Bucket, Key, Body: 'ok' }));
console.log(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString());
await s3.send(new DeleteObjectCommand({ Bucket, Key }));
```

Key prefixes: `uploads/<user-id>/<upload-id>/original`,
`assets/<sha256>.<ext>`, `releases/<project-id>/<release-id>/package.json`
(plus `assets/` inside). Keep storage behind a small adapter interface so the
provider can change.

## 3. Database: Aiven PostgreSQL **[done]**

Provisioned 2026-11-14: service `j26-pg`, PostgreSQL 18, plan `startup-4`, Google
`europe-west4` (Netherlands). It was created in `europe-north1` and migrated,
because Aiven Runtime offers only `europe-west1/2/3/4` on Google. Connected to
both Runtime apps through the canvas integration, which injects `DATABASE_URL`
(direct URI, user `avnadmin`, database `defaultdb`). No PgBouncer pool yet: at
the current scale the API pool (`DATABASE_POOL_MAX=10`) fits the 100-connection limit.

Plan facts (aiven.io/pricing and docs, 2026-11-14):

| Plan | From | Nodes | Backups / PITR | PgBouncer pooling |
| --- | --- | --- | --- | --- |
| Developer | $5/mo | 1 | none | no |
| Hobbyist | $12/mo | 1 | single DR backup (docs disagree) | no |
| **Startup** | **$75/mo ($0.10/h)** | 1 | **2 days** | **yes** |
| Business | $180/mo | primary + standby (HA) | 14 days | yes |
| Premium | $270/mo | primary + 2 standbys | 30 days | yes |

**Choose Startup** (the agreed "backups + pooling" requirement). Note the $50
trial credit covers Startup for roughly 20 days. Upgrade to Business for HA.

Steps:

1. Sign in to console.aiven.io (trial active: $50 for 30 days, no card).
   Pick a region close to Finland/EU (e.g. Google `europe-north1` or AWS
   `eu-central-1`). Keep Runtime and PostgreSQL in the same cloud/region.
2. Create service: PostgreSQL → plan `startup-4` (or the smallest Startup) →
   name `j26-pg`. CLI equivalent:
   `avn service create j26-pg --service-type pg --plan startup-4 --cloud google-europe-north1 --project <project>`
3. Enable a **connection pool** (Pools tab): database `defaultdb`, mode
   `transaction`, size ~20. Use the pooled URI for the API; use the direct URI
   for migrations (transaction pooling breaks session features and named
   prepared statements unless `pgbouncer.max_prepared_statements` is set).
4. Set the backup window (`backup_hour`, `backup_minute`) to quiet hours.
5. Before calling anything production-ready, run a restore drill (fork from a
   backup) and record the result.

Node driver: `pg` 8.23.x. node-postgres treats `sslmode=require` as
`verify-full`, so connecting to Aiven fails with `SELF_SIGNED_CERT_IN_CHAIN`
until the project CA is trusted (seen on the first deploy). Set `DATABASE_CA_CERT`
to the project CA; the pool then verifies the certificate and hostname against it.

## 4. Hosting: Aiven Runtime **[done]**

Deployed 2026-11-14 from `main` via `compose.yaml`: `api` (`Startup-20-512`, port
8080, public URL `https://humorous-active-ladybird.eur-1.aiven.app`) and
`worker` (`Startup-50-1024`, because the worker runs Chromium for fit checks;
port 8080 for `/healthz` only). Both in Google `europe-west4`. The GitHub app has
read access to `VitoPalm/junction26` only. Findings from the first deploy:

- The scan imports compose `environment` and the Dockerfile `ENV` lines as app
  variables. The env editor accepts `.env` text with `# secret` line suffixes.
- The port-less worker question is moot: `WORKER_HEALTH_PORT` makes Aiven treat it
  as a normal app with its own (unused) public URL.
- Until the app releases, its URL answers `302` to an Aiven status page, which
  reports whether the latest release failed. Read the app's Runtime logs for the
  config error.
- URL-dependent variables (`PUBLIC_ORIGIN`, `CLERK_AUTHORIZED_PARTIES`, `CORS_ORIGINS`)
  can only be set after the first deploy, so that deploy fails its config check.

Facts (aiven.io/docs/products/runtime, pages updated Sep–Nov 2026; status is
labelled "New", with no GA/beta statement):

- Deploys containers built from **Dockerfiles in the repo**. Multi-service
  apps use a **Compose file** (`compose.yaml` and similar names are
  auto-discovered). App services must use `build:`. `image:` is honored only
  for recognized data services (`postgres:*` provisions an Aiven PostgreSQL;
  version tags are ignored).
- Connect GitHub by installing the "Aiven Platform" GitHub app (Runtime →
  Deploy application → Connect GitHub account; needs org admin role).
- **Pushing to GitHub doesn't redeploy.** Redeploy from Console → Application →
  Overview → Actions → "Deploy latest commit" (no documented CLI/API for this).
  Saving env vars or ports also redeploys the last deployed commit.
- **Public endpoint is always HTTPS :443**, with TLS terminated by Aiven and
  forwarded as plain HTTP to the container port. HTTP/1 only (no gRPC, HTTP/2 or
  raw TCP). WebSockets aren't documented.
- **No pre-deploy hooks or one-off tasks.** Run migrations from the container
  entrypoint (guarded by a Postgres advisory lock) or from CI before deploying.
- Scaling = plan change only (Startup app plans from $7/mo ≈ $0.01/h, 0.5 CPU,
  0.25–8 GB RAM, 9 sizes). Replicas and autoscaling aren't documented.
- Env vars and secrets: Console → app → Environment variables (tick
  "Secret"), or the API (`"kind": "secret"`).
- Database: a service integration injects `DATABASE_URL` (full URI only).
  A Runtime app **can't** integrate with another Runtime app.

### Files in the repo **[done]**

- [`Dockerfile`](../Dockerfile): one image (node:26-alpine, ~200 MB) with only
  the backend workspaces installed and built. The entrypoint
  ([`scripts/entrypoint.sh`](../scripts/entrypoint.sh)) picks the process from
  `SERVICE_ROLE` and `exec`s node so SIGTERM reaches graceful shutdown.
  Verified locally with podman on 2026-11-14 (build, `/readyz`, clean stop).
- [`compose.yaml`](../compose.yaml): `api` (port 8080, `MIGRATE_ON_START=true`)
  and `worker`, same Dockerfile, different `SERVICE_ROLE`.
- [`.dockerignore`](../.dockerignore): keeps `.env*` secrets, docs and
  experiments out of the build context.

Untested assumption to verify on the first deploy: that a port-less `worker`
service becomes its own Runtime app. `compose.yaml` already sets
`WORKER_HEALTH_PORT=8080`, so the worker answers `GET /healthz` on 8080 and can
be deployed like the API if needed (don't route public traffic to it).

**Before the first deploy, configure Clerk.** Build the author app with its
production publishable key, and set `AUTH_MODE=clerk`, issuer, allowed frontend
origins and a verification key in the backend runtime. Both API and worker use
the shared config parser. The image runs with `NODE_ENV=production`, which
refuses dev auth and Clerk development instances. Overriding it on a public URL
would remove those safeguards. See [authentication-plan.md](authentication-plan.md)
for setup and the remaining native/connector work.

### Deploy steps

1. Add the files above, build locally with `docker build .`, push to `main`.
2. Console → Runtime → Deploy application → pick repo/branch `main` → select
   `compose.yaml` → Scan → Deploy. Choose the smallest Startup app plan for each.
3. Integrate the database with each app:
   `avn service integration-create --project <p> -t application_service_credential -s j26-pg -d <app> --user-config-json '{"service_type":"pg","exposed_values":{"connection_string":{"environment_variable_key":"DATABASE_URL"}}}'`
   (Do this for `api` and `worker`. For the API, point it at the pooled URI if
   the integration exposes the direct one; this isn't documented, so check.)
4. Add the remaining env vars from section 1 as secrets.
5. Ports: `api` → `[{"name":"http","port":8080,"protocol":"HTTP"}]`.
6. Note the public HTTPS URL (Connection information). That URL is what the
   glasses load (`<url>/glasses/`).
7. Every later release: push → Console "Deploy latest commit" for each app.

Health: `GET /healthz` (process up) and `GET /readyz` (DB reachable). Log
JSON with request/job/revision IDs. Graceful shutdown on SIGTERM; workers
release leases.

## 5. Authoring model: OpenRouter **[done]**

- Model `openai/gpt-6-luna`, providers OpenAI / Azure / Amazon Bedrock. Price
  from **$0.05 / $0.25 per M input/output tokens** (cheapest OpenAI endpoint;
  others up to $0.20/$1.00). Supports `response_format` (json_schema),
  `tools`, `reasoning`, `max_tokens`. Measured: one 16-page manual took about
  37k input + 4–5k output tokens, **42–48 s, ~$0.007 per generation**.
- Always send `provider: { require_parameters: true, allow_fallbacks: false }`
  with structured output, so requests route only to endpoints that honor the
  schema. Strict mode is a strong hint on some providers, so **validate locally
  anyway**.
- PDFs: our trials render pages with Poppler (`pdftoppm -scale-to 1600`,
  `pdftotext -layout`) and send page images + text. OpenRouter also accepts PDFs
  directly (`file` content part, `plugins: [{id: 'file-parser', pdf: {engine}}]`,
  engines `native` | `cloudflare-ai` (free) | `mistral-ocr` ($2/1000 pages)).
  Keep our own rendering: we need page bitmaps to crop diagrams anyway.
- Key endpoint `GET /api/v1/key` returns usage and limit without spending.
- Handle 400 (unsupported parameter), 402 (credits/limit), 429, 502 and key
  expiry explicitly. Failed generations aren't billed. Cap retries.
- **Replace the key before 2026-11-21.** Newer models seen on OpenRouter
  (Gemini 4 Hydrogen/Carbon, Nov 2026) cost 30–40× more. Luna remains the
  sensible default; re-evaluate when the Gemini/Anthropic credits arrive.

## 6. Local development

Backend: see [backend-development.md](backend-development.md) (`npm run dev:db`,
`dev:api`, `dev:worker`). The rest of this section covers the experiments and
the glasses UI.

Prerequisites: Node **≥22.18** (26 LTS recommended), podman or docker for the backend database, npm, Google Chrome with
the simulator extension, Python 3 with `requests` + `Pillow`, and Poppler
(`pdftoppm`, `pdftotext`) for the experiment scripts.

```sh
git clone https://github.com/VitoPalm/junction26 && cd junction26
npm ci                       # npm workspaces: packages/* and experiments/*/app
npm run build && npm test    # all workspaces
cd experiments/openrouter-ikea-v2/app && npx vite --host 127.0.0.1 --port 4182
```

Open the URL in Chrome and enable the simulator for the origin. Arrow keys,
Enter and Esc drive focus/select/back. Set Background Blur to 0.
Browser tests: `npx playwright test` in `packages/glasses-ui` (starts its own
servers on 4180/4181) and in `experiments/openrouter-ikea-v2/app` (needs the
4182 server running).

Gotcha: Vite can cache a half-written file if you `cp` over a source it is
watching (empty CSS, missing exports). Write to a temp file and `mv` it, or
touch the file again.

### Onboarding a teammate

Goal: a teammate tests against the real external services without touching the
shared production database.

1. Add them as a collaborator on `VitoPalm/junction26` (private). For redeploy
   rights, also invite them to the Aiven project `vitopalm1982-7b23`.
2. Hand over the secret files over a private channel (password manager,
   Signal), never through chat with an agent or git: `.env.backend.local`,
   `.env.verda.local`, `.env.openrouter.local`, `apps/author/.env.local`.
   In the copy of `.env.backend.local`, keep `DATABASE_URL`/`TEST_DATABASE_URL`
   on the local `dev:db` server (`127.0.0.1:55432`). Don't share the Aiven
   `avnadmin` URI or `DATABASE_CA_CERT`.
3. They sign up with their own account in the Clerk development instance (the
   live `/author/` sign-in). Local Vite origins are already in
   `CLERK_AUTHORIZED_PARTIES`; add any other origin they use.
4. Two ways to test:
   - **Live**: `https://humorous-active-ladybird.eur-1.aiven.app` (`/author/`,
     `/glasses/`, `/v1`). Call `/v1` with `authorization: Bearer <Clerk session token>`
     copied from the signed-in browser.
   - **Local, real services**: section 6 plus [backend-development.md](backend-development.md),
     with `STORAGE_DRIVER=s3` (shared Verda bucket; keys are per user id) and
     `AUTH_MODE=clerk`. `AUTH_MODE=dev` with `Bearer dev:me` is the offline shortcut.
5. Budget: use `fake:demo` / `fake:voice` for routine runs. The OpenRouter key
   is capped at $17 and expires 2026-11-21; `experiments/*/run.py` spends money.

## 7. Glasses device setup **[todo, needs hardware]**

1. Meta AI app v272+, glasses v125+.
2. Enable Developer Mode (Settings → App Info → tap App version ×5 → Enable).
   Restart the glasses and the app so WebMCP picks it up.
3. Add our app: scan the QR for
   `fb-viewapp://web_app_deep_link?appName=Junction26&appUrl=<PUBLIC_ORIGIN>/glasses/`
   (generate it with the simulator's QR tool), then confirm on the glasses.
4. First launch online; check that warm relaunch makes 0 requests; then test
   airplane mode.
5. Feasibility checklist to run first: WebMCP tool appears and is invoked by
   "Hey Meta"; IndexedDB survives app close/reboot; `navigator.storage.estimate()`
   quota; band focus/select; package download time for a ~1 MB applet;
   readability outdoors.

## 8. Cost envelope (hackathon week)

- Aiven: Startup PG ~$2.40/day + 2 Startup apps ~$0.50/day → the $50 credit
  lasts ~2.5 weeks.
- Verda: storage of a few hundred MB costs cents. €200 balance.
- OpenRouter: ~$0.007 per manual-sized generation; $17 cap ≈ 2,000 generations.

## Worker source/fit prerequisites (2026-11-14)

The worker image now installs Poppler (`poppler-utils`) and Chromium for source PDF rendering and generated-candidate fit checks. Local development requires `pdfinfo`, `pdftotext`, `pdftoppm` and Chrome/Chromium; set `CHROME_PATH` when it is outside the detected Linux paths. Build the renderer measurement bundle with `npm run build:fit -w @junction26/worker` before `dev:worker` (the regular worker build includes this step). Missing fit prerequisites fail generation before a paid model call. Source tool limits and the optional paid benchmark are in [model-pipeline.md](model-pipeline.md). The authoring app/worker can perform public web lookups during creation; downloaded glasses applets remain offline.

### Optional external assistant OAuth

The API can now serve the shared OAuth-protected MCP tools at `/mcp`. Configure
`MCP_RESOURCE_URL` (the exact endpoint), `CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` alongside `AUTH_MODE=clerk` and the existing issuer settings.
The Docker image includes the shared MCP tool package. The development Clerk
instance is configured and real local consent/draft creation is verified; no
public MCP deployment is implied. Register the public HTTPS resource in Clerk
and preserve its Host header through the proxy before testing cloud clients.
See [assistant-mcp.md](assistant-mcp.md) for scopes, bootstrap scripts and the
remaining provider acceptance checks.
