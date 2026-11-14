# External assistant MCP: Clerk account linking

Implemented 2026-11-14. This is the text-only implementation of
[the assistant integration exploration](assistant-integrations.md). It shares one
tool contract across Claude and OpenAI MCP clients. Clerk OAuth, consent, PKCE, MCP calls and web-account continuity have been
verified locally with a real development account in Zen. It is **not yet a
deployed Claude/ChatGPT connector** or tested inside either provider's UI.

## What works

`apps/assistant-mcp` contains the shared tool contract. Local stdio uses the
authenticated HTTP API; `/mcp` in the API uses an in-process, scoped backend.
The user's assistant writes the definition itself using the relevant authorized
conversation context. The adapter never calls a model or the managed generation
message endpoint. No provider API key or assistant session is used by our backend.

| Tool | Behavior |
| --- | --- |
| `get_authoring_capabilities` | Current validator schema, format/runtime versions, catalog, limits and policy |
| `list_applets` | Owned project metadata |
| `get_applet` | Revision list, or one explicit immutable definition |
| `validate_applet` | Structural/reference/operation/copy checks without persistence |
| `create_applet` | Atomically create project and immutable draft; durable retry protection |
| `revise_applet` | Save from an exact latest base; stable IDs, program-detected findings, durable retry protection |

Writes return project/revision IDs, findings and a project preview URL. Open the
project and choose Preview; select the returned revision number if a newer draft
has since appeared. The URL currently opens the project, not a revision-pinned
preview. A draft is neither published nor installed on glasses.

Validation uses `packages/applet-format`; it does not measure rendered fit or
verify source fidelity. `assets` must be empty. File transfers, image resolution,
assistant-side publishing and review acceptance are outside this first slice.
Drafts with change findings are blocked by the existing publish API until a
server-side acceptance workflow exists; the current UI checkbox cannot clear that
block. Draft creation/revision never reads or writes live wearer state.

## Clerk OAuth endpoint

The API now serves `/mcp` when `AUTH_MODE=clerk` and `MCP_RESOURCE_URL` are
configured. This is separate from the old `http-local` single-user adapter.
Each POST verifies its own OAuth bearer credential and creates a fresh tool
server. First-party session JWTs, cookies, device tokens and dev tokens cannot
substitute for OAuth access tokens. The SDK checks the signature, audience and
expiry; we additionally enforce the signed JWT issuer explicitly because the
installed SDK's machine-token path did not enforce its issuer option in testing.
Opaque access tokens are verified through Clerk's Backend API.

Permissions:

- `applets:read`: discover capabilities, list/read owned definitions, validate.
- `applets:draft`: create/revise owned drafts. Initialization also requires read.
- No delegated access to publishing, managed generation, uploads, pairing,
  device administration or wearer state. OAuth credentials are rejected by all
  ordinary `/v1` routes, including when a client calls them directly.

The backend receives a distinct delegated principal. It passes identity and
scopes into a bounded in-process dispatcher; no access token is forwarded to a
second resource and no privileged shared token is installed. Both OAuth and web
sessions map the same Clerk issuer/user tuple to `users.id`.

Public discovery is served at `/.well-known/oauth-protected-resource/mcp`
(with a root metadata alias). It advertises the exact resource and Clerk issuer.
Missing/invalid credentials receive a 401 `WWW-Authenticate` discovery challenge;
missing scopes receive 403. Write-tool failures also include the MCP
`mcp/www_authenticate` metadata for reauthorization. Origin/Host checks, body
limits, no-store responses and POST-only stateless transport apply. A reverse
proxy must preserve the canonical Host header.

### Configured development instance

The existing Clerk development instance now has:

- `applets:read` and `applets:draft` custom scopes, descriptions and discovery
  advertising, created in Zen under OAuth Applications → Scopes;
- the local MCP resource `http://127.0.0.1:8080/mcp` registered;
- audience binding and mandatory PKCE S256 enabled;
- CIMD and dynamic client registration enabled;
- read/draft defaults and a dynamic-client ceiling of read/draft/offline access.
  No email or Clerk metadata scopes are requested by our integration.

Backend settings in the ignored `.env.backend.local` include
`MCP_RESOURCE_URL` and `CLERK_PUBLISHABLE_KEY`, alongside the existing secret key.
The secret key is required for opaque token verification even if a JWT public
key is also configured. The user API service was restarted with these settings.

To reproduce the instance settings after creating the custom scopes:

```sh
node --env-file=.env.backend.local scripts/assistant/configure-clerk.ts
node --env-file=.env.backend.local scripts/assistant/configure-clerk.ts --apply
```

The first command prints the proposed settings only; the second saves and checks
them. Configuration is idempotent and the script does not print credentials.

To run the interactive live proof (creates one counter draft, no model call):

```sh
node --env-file=.env.backend.local --conditions=junction26-source scripts/assistant/smoke-oauth.ts
```

It writes an authorization URL under ignored `.data/mcp-smoke/`. Open that URL
in the signed-in browser, authorize the local proof client and let its loopback
callback complete. Keep the process alive throughout consent. Tokens, code and
verifier stay in memory; the result receipt contains only IDs and verification
metadata. Closing the browser before consent or restarting the process requires
a fresh flow. Each run dynamically registers a test client; remove unused test
clients from Clerk when they are no longer useful. The two temporary clients from
our live verification were removed after the proof; the counter draft remains
in the library for inspection.

On 2026-11-14 at 10:18 UTC this flow completed with the actual Clerk account:
six tools were discovered, the counter validated, a draft was created, and
“MCP OAuth proof” appeared in the signed-in web library in Zen. This proves local
account linking, not integration inside Claude/ChatGPT, public routing or glasses
behavior. With separate Vite/API ports, open the project in Vite's `/author/`
client; generated URLs use `PUBLIC_ORIGIN` and assume the deployed same-origin
web host.

JWT OAuth verification does not contact Clerk on every request: revoking a grant
does not guarantee immediate rejection of an already issued JWT; it can remain
usable until its expiry plus the SDK's clock tolerance. Opaque credentials use
Clerk's verification API. Live expiry/refresh/revocation behavior in actual
Claude/ChatGPT clients remains to be exercised.

## Run privately

Requires the normal root `npm install`, a migrated local backend, and Node >=22.18.
Use the local backend setup in [backend-development.md](backend-development.md).
No worker or funded model is needed for these tools.

Copy `.env.assistant.example` to `.env.assistant.local` at the repository root.
Keep the API at `http://127.0.0.1:8080` and use the same `dev:<name>` identity as
the local authoring UI. Do not expose or tunnel an API using `AUTH_MODE=dev`.
Set the backend's `PUBLIC_ORIGIN` to the address where its built authoring UI is
served so returned project links work. The preview UI still requires its own
sign-in/session; links never contain credentials.

For a local MCP client that launches a stdio subprocess:

```sh
npm run dev -w @junction26/assistant-mcp
```

For actual client configuration, launch **Node directly**, not `npm`, to avoid npm
banners on MCP stdout. The general command/arguments are:

```text
command: /absolute/path/to/node
args:
  --env-file=/absolute/path/to/junction26/.env.assistant.local
  /absolute/path/to/junction26/apps/assistant-mcp/src/main.ts
```

Use an absolute Node executable and paths from the client machine. The entrypoint
runs TypeScript directly and imports no repo workspace packages. Alternatively,
`npm run build -w @junction26/assistant-mcp` and launch `dist/main.js` with Node.
Never put credentials in a checked-in MCP client configuration or command line.
Provider-specific installation and host confirmation behavior still need actual
client tests; successful SDK tests do not establish account eligibility.

For local Streamable HTTP protocol development:

```sh
npm run dev -w @junction26/assistant-mcp -- http-local
```

Endpoint: `http://127.0.0.1:8090/mcp` (port configurable with
`JUNCTION26_MCP_PORT`). This listener deliberately binds only IPv4 loopback,
accepts only that Host, rejects browser Origin headers, and has no multi-user
authentication. It uses one local author's configured token. **Never expose or
tunnel it.** Stdio has no listening socket.

The API client refuses device tokens, remote use of dev tokens, non-HTTPS remote
origins, credential-bearing URLs, and redirects. Tool errors preserve API
validation/conflict details; unexpected transport errors do not print secrets.
No request bodies or tokens are logged by the adapter.

## Validation and retry behavior

Each write supplies an `operationId` (8–128 printable ASCII characters). Reuse it
with the same content after an interrupted response. Changed content requires a
new ID. The backend transaction stores the result with a canonical request hash,
scoped to the owner. Concurrent duplicates and later process restarts return the
same IDs; mismatched reuse returns `idempotency_key_reused`.

A revision must name the latest base. A different write that wins the race causes
`stale_revision`; read that latest definition, preserve its IDs and merge the
requested change before submitting with a new operation ID. Findings are computed
against both the selected base and the current published definition so a chain of
drafts cannot hide impacts on the live release. Legacy bases the full validator
cannot interpret are rejected rather than silently treated as empty.

## Verified and remaining work

Automated checks cover MCP tool discovery/calls over stdio, SDK in-memory and real
local Streamable HTTP transports, validation, API ownership, device refusal, concurrent
write retries, stale edits, publication review blocks and no generation jobs or
wearer-state writes. These checks are local, not provider or glasses hardware tests.

Before connecting a cloud-hosted Claude or ChatGPT client:

1. Choose a reachable HTTPS endpoint, register that exact `/mcp` URL in Clerk,
   set `MCP_RESOURCE_URL` to match, and deploy the API with real Clerk auth.
   This does not require switching away from the development instance for the
   hackathon. Do not expose `AUTH_MODE=dev` or the single-user `http-local` adapter.
2. Test the intended provider account: discovery, consent, requested scopes,
   tool confirmations, reconnect/refresh and revocation. No provider-client
   eligibility is implied by our local SDK proof.
3. Complete measured fit and exact-revision review acceptance before adding an
   assistant publish tool. Add attachments/provider packaging after that proof.

The architecture follows the providers' MCP direction:
[Claude server guide](https://claude.com/docs/connectors/building),
[OpenAI server guide](https://developers.openai.com/plugins/build/mcp-server),
and the [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server).
