# Authentication implementation plan

Status: Clerk selected by the owner, 2026-11-14. Web sign-in and backend session
verification implemented and tested locally with signed fixtures. A Clerk
development application is configured in ignored local env files. Real Google
sign-in, authenticated library retrieval and session persistence after reload
were verified in Zen against the local API. Native account sign-in code exists (email in the WebView and system-browser
social OAuth with a callback), but end-to-end native verification and production
deployment remain pending. See [native app setup](apps.md#android-emulator). The API now
implements scoped MCP OAuth, verified with real local consent and draft creation
in Zen; cloud-provider connector tests and a public HTTPS endpoint remain.

Hackathon priority (owner decision): keep the Clerk development instance for now
and focus next on delegated MCP account linking. Native sign-in verification remains on the
backlog; phone users can use web authoring. Production provisioning is deferred,
and the production configuration safeguards remain in place.

Deployment decision (owner, 2026-11-14): the first Aiven deployment uses the Clerk
development instance through the explicit opt-ins `CLERK_ALLOW_DEVELOPMENT_INSTANCE=true`
(backend) and `VITE_CLERK_ALLOW_DEVELOPMENT=true` (`apps/author/.env.production`).
Development instances are capped at 100 users and show a development badge. Switch
to a production instance (own domain) and remove both opt-ins for a real release.

## Configure web accounts

1. Create a Clerk application and enable the desired sign-in methods. Use a
   development instance for local Vite and a production instance for releases.
2. Copy `apps/author/.env.example` to `apps/author/.env.local`, set
   `VITE_AUTH_MODE=clerk` and `VITE_CLERK_PUBLISHABLE_KEY`. The publishable key is
   public; never put the secret key in a `VITE_` variable.
3. In `.env.backend.local`, set `AUTH_MODE=clerk`, `CLERK_ISSUER` to the exact
   HTTPS issuer from the Clerk instance, and `CLERK_AUTHORIZED_PARTIES` to the
   exact frontend origins (e.g. `http://127.0.0.1:5173,http://localhost:5173`).
   Set `CLERK_SECRET_KEY` in that ignored file or runtime secrets. Alternatively,
   set `CLERK_JWT_KEY` to the instance's PEM RSA public key for networkless
   verification. Literal `\n` separators are supported. A configured PEM takes
   precedence over secret-key retrieval; update it when Clerk rotates keys.
4. Restart the API and Vite authoring app. Sign in and create an applet. Repeat
   with a second account and verify the libraries remain separate. Pair glasses
   from the signed-in account using the existing pairing flow.
5. For deployment, set HTTPS allowed origins and build with a `pk_live_…` key.
   Production config refuses dev auth and, without the explicit hackathon
   opt-in described above, Clerk development issuers/secret keys.
   Native shells run Clerk's web sign-in inside the WebView (`apps/author/.env.native`,
   plus `https://localhost` in `CLERK_AUTHORIZED_PARTIES`). Email/code uses the embedded UI; social
   OAuth uses `src/native-oauth.ts` to open the system browser and handle
   `com.junction26.applets://oauth-callback`. That code is implemented but not
   verified end to end. Native setup and origin limitations are in
   [apps.md](apps.md#android-emulator).

No first-party session credentials are saved by our app in localStorage; Clerk
owns its session lifecycle. API requests call the SDK token getter every time.
API verification checks signed short-lived credentials, not live session status
on every request: a copied JWT can remain usable until expiry plus the SDK's
five-second clock tolerance (normally about one minute). Logout ends the browser
session, but is not an immediate revocation guarantee for an already issued JWT.
Device credentials have independent, immediate server-side revocation.

## What is blocked

- Public authoring: the Clerk code path and local development instance are
  verified. Production instance/domain configuration and deployment remain.
- Cloud Claude/ChatGPT connections: the scoped `/mcp` endpoint is implemented,
  but still needs a public HTTPS URL and actual provider-client tests. The old
  `http-local` adapter remains a separate private, single-author transport.
- Account continuity is now verified locally: a real OAuth-created draft appeared
  in the same account's signed-in web library in Zen.

Glasses already have one-use pairing codes, hashed device credentials and device
revocation. They need an authenticated phone account to pair against, not an
OAuth login on the glasses. Offline rendering and local actions do not depend on
OAuth. Deployment also still needs its database, storage and hosting configured;
authentication alone does not finish deployment.

## Selected direction

Use one managed identity/authorization provider for app sign-in and assistant
consent. Clerk is selected: its current documentation covers both and explicitly
documents MCP resource audiences, token verification and client onboarding.
Confirm applicable OAuth plan limits, custom scopes and Capacitor support as
those flows are implemented. A Google login connection can be one sign-in method within
that provider; a Google login button alone does not provide our MCP authorization
server.

The [Clerk MCP guide](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server)
documents audience validation and per-request OAuth authentication. The
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
requires protected-resource discovery and audience-bound access tokens. It now
prefers Client ID Metadata Documents (CIMD); dynamic client registration (DCR)
remains a compatibility path. Test the actual target clients instead of assuming
one registration mechanism works everywhere. These are documentation findings,
not a verified Junction26 integration.

## Implementation sequence

1. **Prove provider configuration.** Configure a development application and
   stable HTTPS origins. Verify ordinary web login, MCP consent, the canonical
   MCP resource audience, required scopes and target-client registration. Record
   the chosen issuer, callback URLs and token types without recording secrets.
   Prove the native system-browser/callback flow separately; a React web login
   inside Capacitor is not evidence of native OAuth support.
2. **Add authenticated app sessions.** Extend `packages/server-common/src/config.ts`
   with an explicit real auth mode and validated provider configuration. In
   `apps/api/src/auth.ts`, verify provider credentials before mapping to a user.
   Keep the production dev-mode refusal. Use a stable, unambiguous provider
   instance/issuer + user subject key in `users.external_id`, shared by web and
   MCP. Do not use email or display name as identity or automatically merge a
   `dev:<name>` library. Any dev-data transfer needs an explicit ownership-safe
   migration. Existing project ownership filters can remain in place.
3. **Replace the authoring session source.** `apps/author/src/api.ts` captures a
   fixed token and saves it in localStorage today. Accept an asynchronous token
   source so requests use current credentials; handle expiration, refresh and
   provider logout. Replace the name form in `App.tsx` with provider sign-in,
   retaining the dev form only in explicit development mode. Native OAuth uses
   an external user agent, PKCE and registered callback handling; keep durable
   native credentials in platform secure storage. No client secret ships in
   the web or native bundle.
4. **Introduce delegated permissions before accepting connector tokens.**
   `Principal` currently distinguishes only user/device, and `requireUser`
   grants every authoring operation. Add a distinct delegated principal with
   validated user, client, resource and grants. Start with applet read and draft
   write permissions; enforce them server-side on every accessible operation.
   A draft-only credential must fail at release publication, managed generation,
   uploads, pairing, device management and wearer-state access, even when used
   directly against `/v1`. Do not rely on which tools the MCP server advertises.
5. **Host the shared MCP tools with per-request identity.** Keep the current
   local adapter for development. Add a separate authenticated hosted entry
   point, public protected-resource metadata and `WWW-Authenticate` challenges.
   Bind each request to its own verified subject and scopes, with strict issuer,
   resource/audience and expiry checks. Reuse the backend's authoring operations
   through an in-process service interface rather than forwarding a token meant
   for `/mcp` to a different resource or installing a shared privileged API
   token. Refactor the tool factory to accept that interface while preserving
   its existing HTTP adapter. Preserve ownership, validation and idempotency.
6. **Exercise the full boundary.** Sign in on the phone, connect an assistant
   using the same account, create a draft, open its preview, publish through the
   authoring UI, then pair/sync glasses. Verify a second account cannot read the
   draft. Exercise logout, token expiry and grant revocation with documented
   propagation bounds. Record actual Claude/ChatGPT connector results separately
   from local protocol tests and glasses hardware results.

## Acceptance checks

- Production config accepts the real mode and rejects dev auth; missing provider
  settings fail at startup. Provider errors fail closed without logging tokens.
- Forged, expired, wrong-issuer, wrong-resource and wrong-token-type credentials
  fail. Provider user sessions and delegated OAuth tokens have separate policies.
- Web and MCP for the same provider account resolve to the same internal user;
  different accounts cannot cross ownership boundaries. Email changes do not
  change ownership.
- Delegated read access cannot write drafts; draft access cannot publish or call
  other user-only APIs. Device tokens cannot become authoring credentials.
- Simultaneous MCP requests from different users do not share account context.
- Discovery and challenges identify the exact configured resource. Test PKCE,
  registration, consent, reconnect and revocation against real target clients.
- Pairing, device revocation and offline use continue to work. App sign-out and
  connector disconnection have explicit behavior; neither silently deletes data.

## First implementation slice (locally verified)

Web sign-in, backend verification and a refreshable token source are implemented,
with negative authentication tests and database-backed ownership/pairing tests.
Production configuration is tested with a local signing key. Real Google login
to the development instance loads an authenticated library and survives reload
in Zen. Production instance verification remains. Follow with delegated
permissions and MCP account linking. Native callback verification and public
connector verification remain explicit work, not implied by a successful web
login. Assistant-side publication remains separately blocked on measured fit and
exact-revision review acceptance described in [assistant-mcp.md](assistant-mcp.md).

## MCP account-linking implementation (2026-11-14)

Steps 4 and 5 now have an implementation: a separate delegated principal,
`applets:read` / `applets:draft` authorization, Clerk OAuth-only verification,
canonical audience and issuer checks, protected-resource metadata/challenges,
and a request-scoped MCP server. Tokens are never forwarded into `/v1`; the
server dispatches only allowed operations through an in-process interface.
Web and MCP identity share the existing Clerk issuer/user tuple.

The real development instance is configured with both custom scopes, audience
binding, PKCE S256, CIMD/DCR and scoped defaults. A live local OAuth proof in Zen
completed consent, exchange, tool discovery, validation and draft creation. The
same draft appeared in the web library. Negative signed-token tests cover issuer,
audience, expiry, session/device refusal, scoped writes and cross-user IDs.
See [assistant-mcp.md](assistant-mcp.md) for commands and verification limits.
Actual Claude/ChatGPT cloud routing, refresh/revocation behavior, and native
sign-in remain separate acceptance work.
