# Backend development

How to run, test and change the backend (`apps/api`, `apps/worker`,
`packages/db`, `packages/storage`, `packages/server-common`). Contracts:
[api.md](api.md), [jobs.md](jobs.md), [database.md](database.md). Deployment:
[infrastructure-setup.md](infrastructure-setup.md).

## Layout

```text
apps/api/              HTTP API (Hono on Node). src/app.ts builds the app; src/main.ts listens
  src/routes/          projects, authoring (messages + revisions), releases, state, uploads, misc
  src/auth.ts          sessions: dev user tokens, device tokens, pairing codes
apps/worker/           job runner (src/runner.ts) and job handlers (src/handlers.ts)
packages/db/           migrations/*.sql, migrator, typed queries, test-database helper
packages/storage/      ObjectStore adapter: S3 (Verda), local filesystem, memory
packages/server-common config loader (env contract), JSON logger, shutdown, interim definition check
scripts/dev-db.sh      local PostgreSQL 18 in podman/docker
scripts/entrypoint.sh  container entrypoint (SERVICE_ROLE=api|worker|migrate)
Dockerfile, compose.yaml   one image for both processes (Aiven Runtime)
```

Dependencies only point "down": apps → packages; `db`, `storage` and
`server-common` don't depend on each other.

## First run

Needs Node ≥ 22.18 (26 LTS in the container) and podman or docker.

```sh
npm ci
npm run dev:db                              # starts PostgreSQL on 127.0.0.1:55432, prints URLs
cp .env.backend.example .env.backend.local  # then set SESSION_SECRET (command is in the file)
chmod 600 .env.backend.local
npm run dev:api                             # http://127.0.0.1:8080, migrates on start, restarts on change
npm run dev:worker                          # second terminal
```

Dev scripts load `.env.backend.local`, then `.env.verda.local` and
`.env.openrouter.local` if present (Node `--env-file-if-exists`). Variables
already set in the shell win. Locally, `STORAGE_DRIVER=fs` keeps objects in
`.data/objects` (git-ignored) so the API and the worker share them. Set
`STORAGE_DRIVER=s3` to use the real Verda bucket.

Try it:

```sh
B=http://127.0.0.1:8080; A='authorization: Bearer dev:me'; J='content-type: application/json'
curl -s $B/readyz
P=$(curl -s -H "$A" -H "$J" -d '{"title":"Row counter"}' $B/v1/projects | jq -r .project.id)
R=$(curl -s -H "$A" -H "$J" -d '{"definition":{"formatVersion":1,"title":"Row counter"}}' \
      $B/v1/projects/$P/revisions | jq -r .revision.id)
curl -s -H "$A" -H "$J" -H "idempotency-key: $(uuidgen)" \
     -d "{\"revisionId\":\"$R\",\"expectedCurrentReleaseId\":null}" $B/v1/projects/$P/releases
curl -s -H "$A" $B/v1/projects/$P/releases/latest     # ready after the worker's next poll
```

## Tests

```sh
npm test                                   # every workspace
npm test -w @junction26/api                # one workspace
```

Tests use Node's built-in runner on the TypeScript sources (type stripping, no
build step). Database tests need `TEST_DATABASE_URL` (it's in
`.env.backend.example`). Each test file gets a fresh, migrated database that's
dropped afterwards. Without the variable, those suites show as **skipped** with
the reason. CI must set it.

| Suite | Covers |
| --- | --- |
| `packages/server-common` | env parsing, production refusals, interim definition check |
| `packages/storage` | memory and fs stores; aborted writes leave nothing |
| `packages/db` | migrations (idempotent, checksum guard), revision numbering, job claim/lease/fencing/retry/cancel/shutdown, state backup outcomes |
| `apps/api` `api.test.ts` | auth, ownership (404s), validation, idempotency, uploads (limits, sniffing), pairing, state, publish preconditions |
| `apps/api` `e2e.test.ts` | author → publish → worker packages → sync → download (hash/ETag/304) → backup → restore; publish race; generation placeholder; upload preparation |
| `apps/worker` | runner: success, retries + `onFailed`, cancel via signal, lease recovery, generation cap, shutdown requeue |

Manual checks (not in `npm test`):

- `npm run smoke:storage` round-trips one small object through the real Verda
  bucket under `healthcheck/` and deletes it (requests are free). Last passed
  2026-11-14.
- Container: `podman build -t j26-backend .`, then run it with
  `--network host -e DATABASE_URL=… -e SESSION_SECRET=… -e STORAGE_DRIVER=memory
  -e NODE_ENV=development`. Built and served `/readyz` on 2026-11-14.

## Conventions

- **TypeScript runs as written.** Source imports use `.ts` extensions;
  `tsc -p tsconfig.build.json` rewrites them to `.js` in `dist/`. Only
  erasable syntax (no enums, namespaces or parameter properties). The
  `junction26-source` export condition points dev, tests and typecheck at
  `src/`; production (`node dist/main.js`) uses `dist/`. Build order is
  `packages/*` then `apps/*`, which matches the workspace order.
- **Errors** are `ApiError(status, code, message, details)` in the API and
  `JobError(code, message, { retryable })` in the worker. Codes are stable;
  document new ones in api.md / jobs.md.
- **Logs** are JSON lines with IDs (`requestId`, `jobId`, `projectId`,
  `userId`). Never log tokens, secrets, request bodies, chat text, documents
  or snapshots. Routes are logged by pattern, not URL (query strings can hold
  filenames).
- **Views.** Responses go through the view functions in `apps/api/src/http.ts`.
  Object keys, lease owners and token hashes never leave the server.
- **Transactions** for anything that touches more than one row with a rule
  between them (`withTransaction`). Lock the project row (`forUpdate`) when
  changing what a project points to.
- **New tables or columns** need a new migration file (never edit an old one);
  see [database.md](database.md#migrations).
- **Docs move with code.** Update api.md/jobs.md/database.md in the same change
  as the behavior.
