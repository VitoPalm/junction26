# Authoring from Claude, ChatGPT and other assistants

Research date and last source/code recheck: 2026-11-14 (code baseline
`e76b1c8`). **Architecture proposal with a private local implementation; not yet a
provider-client-tested or hosted integration.** This expands the agreed
bring-your-own-assistant direction in
[product-spec.md](product-spec.md#authoring-and-model-strategy) and
[implementation-plan.md](implementation-plan.md#m7-bring-your-own-assistant-stretch).
It does not change the applet format or the managed authoring path.

## Implementation started (2026-11-14)

The shared MCP adapter and private text-only draft API now exist. They expose
capabilities, owned applet reads, full definition validation, atomic create and
revision submission with durable retry protection. See
[local MCP setup and remaining work](assistant-mcp.md). They do not route through
managed generation. Change findings are stored for publication enforcement;
Clerk OAuth account linking is now implemented and locally verified through real
consent, draft creation and web-library continuity. Assistant-side publish, review
acceptance, measured fit, public HTTPS hosting and provider-client tests remain
unfinished. The design discussion below describes the target flow,
not a claim that all proposed tools are available.

## Intended experience

A person already discussing a crochet pattern, recipe, or D&D character with
Claude asks: “Use what we've worked out here to make an applet for my glasses.”
They connect Junction26 once, sign in, and let their assistant create a draft.
They preview it, refine it in that conversation, then publish to their Junction26
library. The glasses download the release through the existing explicit sync
flow; this does not require a live connection from Claude to the glasses.

**Recommended approach:** one hosted MCP authoring server, initially tested as a
Claude custom connector, then against ChatGPT/Codex. Keep provider-specific
packaging and optional in-chat UI outside the core authoring service.

## What the providers currently support

Claude's official developer docs recommend Streamable HTTP for remote servers.
Tools can read and write application data. Custom connectors are added by URL
without directory review; directory discovery requires review. Optional plugin
packaging can bundle the connector with instructions, and optional MCP Apps can
provide an in-chat interface. None of these require a separate applet engine.
[Claude server documentation](https://claude.com/docs/connectors/building).

Claude's setup guide currently lists custom connectors across Free and paid
plans, with one custom connector on Free. Organizational permissions apply.
Remote connections originate in Anthropic's cloud, including when used from
desktop/mobile, and require a reachable HTTPS endpoint on port 443. Verify the
actual target account during the prototype; do not promise a localhost-only
server will work in ordinary Claude chat.
[Claude setup and availability](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

OpenAI's current documentation calls the integration a plugin with an MCP
server; older Apps SDK URLs redirect to these docs. A custom UI is optional and
the server can expose tools to ChatGPT and Codex. Start with tools and a link to
our preview rather than building a provider-specific renderer.
[OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server).

OpenAI's help page currently documents custom MCP connections with full write
support for Business and Enterprise/Edu on ChatGPT web, subject to workspace
permissions. This does not establish that every personal ChatGPT account can
install our development connector. Check the intended test account explicitly.
[ChatGPT custom connections](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).
Public distribution is a separate submission/review step, not a prerequisite for
proving the authoring tools privately.
[OpenAI submission](https://developers.openai.com/plugins/deploy/submission).

## How existing conversation context gets used

The assistant remains the author. It sees whatever context its host makes
available in that conversation, obtains our schema and capabilities, writes a
definition, and passes the definition to our tool. Our server receives tool
arguments, not unrestricted access to the assistant's history or memory.

This is a proposed application flow based on tool calling, not a verified
promise about cross-chat recall, Projects, memory, or attachment access. Test
each desired context source. Do not require a user to export their whole chat.
Send only the content and sources needed for the applet.

A PDF attached in Claude is not automatically an upload in Junction26. Text
applets can be the first proof. Preserving original diagrams requires a tested
way to transfer authorized source bytes into our upload API; do not assume a
host's file URL is public or durable. Until that exists, provide a link to
upload the original in our authoring client and reuse its owned asset IDs.
Do not accept arbitrary remote URLs as an implicit asset ingestion mechanism.
The current app can accept attachments as model context, but resolving uploaded
images into downloadable applet assets and preparing PDF diagrams are still
planned; uploading a file alone does not complete diagram delivery. See
[apps.md](apps.md#planned-images-in-applets-not-built).

## Proposed authoring tools

The complete target tool set below remains a design proposal. The implemented
subset and its API contract are documented in [assistant-mcp.md](assistant-mcp.md)
and [api.md](api.md#external-assistant-drafts-private-local-proof).
Expose essential guidance through tools so the flow does not depend on a host
supporting MCP resources, prompts, sampling, or a provider-specific skill.

- `get_authoring_capabilities`: return the actual supported format/runtime
  versions, JSON schema, component/action catalog, copy limits, and authoring
  guidance. Include no-scrolling and additive-display requirements. Version this
  response with the validator rather than copying a second schema into prompts.
- `list_applets` / `get_applet`: list owned projects and retrieve an explicit
  revision for edits. Live wearer state is separate; do not return or overwrite
  it by default.
- `create_applet`: accept a title, complete definition and operation ID. Create
  a project and immutable draft revision; return IDs, validation issues and a
  preview link. No managed generation call.
- `revise_applet`: accept project ID, base revision ID, definition and operation
  ID. Preserve stable view/state/action IDs; return change-review findings.
- `validate_applet`: report schema, references, copy constraints, supported
  operations and measured fit. If measurement is asynchronous, return a job ID;
  never imply structural validation alone establishes fit or source fidelity.
- `publish_applet`: accept the exact reviewed revision, expected current
  release ID and idempotency key. Enforce preview/change review in the backend,
  then use the existing release packaging flow. Return pending status and job ID.
- `get_operation`: retrieve owned validation/packaging job status. “Queued” is
  not “published”; “published” is not “downloaded on the glasses.”

Creating/revising/publishing are write tools. Mark read tools accurately in MCP
annotations, but enforce authorization, validation and review server-side.
For the first proof, the user completes publish in our preview UI. Add
assistant-side publish once that same review enforcement exists behind it.

## Existing code and missing foundations

The backend already has the important seam: `POST /v1/projects/:id/revisions`
accepts a complete external definition without routing through our authoring
model. See [API revisions](api.md#revisions) and
[`authoring.ts`](../apps/api/src/routes/authoring.ts). The existing release API
has asynchronous packaging, required publish idempotency, and an expected-base
check. All tools should reuse the same application behavior and owner filters.

Do **not** implement this as a wrapper around `POST .../messages`: that delegates
generation back to our paid worker and loses the point of using the assistant
that already has the user's context. Our hosting/storage/processing costs still
exist; “bring your own assistant” does not mean all operations are free.

The format, validator, runtime, renderer and phone preview are now implemented
as an MVP; see [apps.md](apps.md). Reuse `validateDefinition`, the capability
catalog and authoring guidance from `packages/applet-format`, plus the shared
renderer/runtime for preview. The generation worker already uses full format
validation. These are code-inspected facts; this research pass did not rerun the
app's recorded browser/emulator checks or real model generation.

The direct revision API still calls the interim
[`checkDefinition`](../packages/server-common/src/definition.ts). It checks a
few envelope fields and size, not the complete runtime contract or measured fit.
The private external draft endpoint now uses the full validator. The older
direct revision endpoint still needs migration before it can be treated as an
equivalent production submission path. Change diff and a review checkbox exist
in the authoring client,
but the review-acceptance endpoint and measured fit at publish are unfinished.
The release route has a review check, but external submissions must also create
the findings and support server-side acceptance; the client checkbox alone is
not sufficient enforcement. A stored revision marked valid by the interim check
does not establish readiness for glasses.

Suggested implementation boundary: an MCP transport adapter over shared
authoring services. Either extract those services from routes or call the
authenticated HTTP API; never write a second persistence/publication pipeline.
The private external draft endpoint now provides durable create/revise retry
protection; the older project and revision endpoints still lack it. A retry
after a lost response must not create duplicate projects or revisions.

## Account linking and deployment

Public multi-user use depends on real Junction26 sign-in. `AUTH_MODE=dev` is
local-only and must never be exposed through a public MCP endpoint or tunnel.
Use per-user OAuth account linking with narrowly scoped read/draft/publish
permissions, revocation, and ownership checks on every referenced ID.
Glasses device tokens must not become authoring credentials.

OpenAI documents OAuth 2.1, protected-resource and authorization-server metadata,
PKCE S256, resource audience handling, and supported client registration
mechanisms. Select an identity/authorization provider that supports this MCP
contract; a generic “Sign in with Google” button alone does not implement it.
[OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth).
Claude has its own registration and callback requirements; validate both hosts
against the same authorization setup rather than assuming OAuth interoperability.
[Claude authentication entry point](https://claude.com/docs/connectors/building).

Serve a Streamable HTTP `/mcp` endpoint over HTTPS. Verify proxy behavior on the
chosen host before relying on streaming. Use ordinary short tool responses and
durable job IDs for lengthy work. Tokens, chat text, documents and definitions
must stay out of request logs. No provider API key or personal assistant session
is needed on our server for the external assistant to author a definition.

This server is distinct from **WebMCP on the glasses**, which exposes active
applet actions to Meta AI. Neither substitutes for the other.

## Smallest useful implementation sequence

1. Reuse the implemented format, validator and preview. Connect the direct
   revision API to full validation, and expose versioned capability/schema tools.
   Build a text-only counter/checklist proof; keep local development private.
2. Add real user auth and MCP OAuth account linking, then a hosted private
   Claude connector. Exercise create, invalid-definition feedback, revision and
   preview with a real account and context from an existing conversation.
3. Add durable create/revise idempotency and shared change-review enforcement.
   Test interrupted requests, cross-user IDs, stale edits, revoked access and
   publishing races. Keep wearer state intact through layout changes.
4. Test the same endpoint in the intended OpenAI account/surface. Record actual
   account eligibility, tool discovery, OAuth, errors and confirmation behavior.
5. Add original-file/diagram transfer and optional in-chat previews after the
   text flow succeeds. Package/list the connector for easier discovery after
   client tests; directory approval is a separate milestone.

Acceptance example: in an existing Claude conversation about a crochet pattern,
ask for a row counter using its stated repeat counts; create and preview a valid
applet; revise its layout without resetting progress; publish the reviewed
revision; explicitly sync it into the glasses client. Record simulator and
hardware results separately. None of this end-to-end flow has been verified yet.
