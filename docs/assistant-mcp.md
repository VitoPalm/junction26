# External assistant MCP: local development

Implemented 2026-11-14. This is the first private, text-only implementation of
[the assistant integration exploration](assistant-integrations.md). It shares one
tool contract across Claude and OpenAI MCP clients. It is **not yet a deployed
Claude/ChatGPT connector** and has not been tested inside either provider's UI.

## What works

`apps/assistant-mcp` is a thin MCP transport adapter over the authenticated API.
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

Before a hosted connector:

1. Select real user authentication and an OAuth authorization provider. Add MCP
   protected-resource metadata, audience/scopes, PKCE, client registration and
   revocation, with each request bound to its own user. Do not publish this
   single-user local HTTP listener.
2. Mount the shared tool server behind that authenticated Streamable HTTP
   boundary, without a shared authoring token. Verify proxy/HTTPS behavior.
3. Complete measured-fit and exact-revision review acceptance in the shared
   backend before adding a publish tool.
4. Exercise the existing-conversation counter/checklist flow in a Claude custom
   connector, then the intended ChatGPT/OpenAI account. Record tool discovery,
   OAuth, confirmations, errors, account eligibility and explicit glasses sync.
5. Add provider packaging/directory submissions and attachments after that proof.

The architecture follows the providers' MCP direction:
[Claude server guide](https://claude.com/docs/connectors/building),
[OpenAI server guide](https://developers.openai.com/plugins/build/mcp-server),
and the [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server).
