# Staging OAuth

Staging has a separate entry point, `src/staging.ts`. It uses Cloudflare's maintained `@cloudflare/workers-oauth-provider` 1.2.3, rather than implementing authorization codes, token storage or refresh itself. Production continues to enter through `src/index.ts` and retains its existing Bearer authentication. The OAuth version was deployed to staging on 2026-10-19; actual user login and token exchange from ChatGPT remain to be verified.

## Login and authorization

1. ChatGPT requests `/mcp` and receives a 401 challenge pointing at protected-resource metadata.
2. ChatGPT discovers the OAuth endpoints and dynamically registers a client at `/oauth/register` (DCR). Only exact redirect URIs in `OAUTH_REDIRECT_URIS` are permitted.
3. Nora sees the client name, exact redirect URI and requested scopes on a browser-bound consent page. A registered client's name is self-asserted; confirm the redirect before approving.
4. After consent, GitHub authenticates Nora. An exact immutable GitHub numeric ID must match `OAUTH_ALLOWED_GITHUB_ID`. No repository or email scopes are requested and no GitHub token is saved.
5. The provider issues a resource-bound authorization code. ChatGPT exchanges it using S256 PKCE, then sends the access token to `/mcp`.
6. Access tokens last 15 minutes; rotating refresh tokens have a fixed 7-day grant lifetime. Reauthorization requires GitHub login and consent again. PKCE is required even for confidential clients.

Only the two MCP scopes `mcp:tools` and `mcp:events` are granted. `offline_access` may also be requested for refresh. Every protected request and refresh checks that the stored GitHub ID still matches the configured Nora ID. Static `MCP_AUTH_TOKEN` is not accepted by the new staging entry point.

OAuth access does not grant new Notion permissions or add new write tools. Existing event subscriptions retain owner `nora` for continuity. Event callback challenge and Standard Webhooks signatures remain independent of OAuth login.

## Three different callbacks

| Purpose | Where it is configured | Value |
| --- | --- | --- |
| GitHub sends identity back to the Worker | Dedicated staging GitHub OAuth App | `https://personal-ai-os-staging.noradev.workers.dev/oauth/github/callback` |
| Worker sends OAuth code back to ChatGPT | `OAUTH_REDIRECT_URIS` and ChatGPT connection management | Copy the exact URI shown by ChatGPT; the initial candidate is `https://chatgpt.com/connector_platform_oauth_redirect` |
| Worker delivers MCP Events to ChatGPT | `MCP_CALLBACK_ORIGIN` | Exact origin supplied in ChatGPT's actual event subscription; still pending |

The provider advertises RFC 9207 issuer identification and includes `iss` in authorization responses. The stable ChatGPT redirect is expected for this flow, but the exact management-page URI is authoritative. Do not add a wildcard or use an OAuth redirect as the event callback origin.

## Required configuration

| Name | Kind | Notes |
| --- | --- | --- |
| `ENVIRONMENT` | staging var | `staging` |
| `OAUTH_ISSUER` | staging var | Exact public HTTPS origin, no path or trailing slash |
| `OAUTH_REDIRECT_URIS` | staging var | JSON array of exact HTTPS ChatGPT OAuth redirect URIs; no wildcard |
| `OAUTH_KV` | staging-only KV binding | Independent namespace `staging-personal-ai-os-staging-oauth`, ID `e4f50472d5be477a99e22260d71973ed`; bound to deployed staging OAuth version |
| `OAUTH_GITHUB_CLIENT_ID` | staging secret | New GitHub OAuth App dedicated to this environment |
| `OAUTH_GITHUB_CLIENT_SECRET` | staging secret | Never enter this secret in ChatGPT or Notion |
| `OAUTH_ALLOWED_GITHUB_ID` | staging secret | Nora's verified immutable GitHub numeric user ID, not login/email |
| `MCP_CALLBACK_ORIGIN` | existing staging secret | Independent event receiver origin |

GitHub App credentials must be configured together. Missing/invalid configuration fails closed with 503. The repository contains only placeholders. The actual numeric Nora ID must be checked against the authenticated GitHub account before configuration; tests use fictitious ID `12345` only.

No new D1 migration is needed. OAuth codes, hashed tokens and encrypted grant properties use staging-only KV. Existing staging D1 continues to hold event subscriptions and deliveries. CIMD URL fetching is disabled; this implementation deliberately uses DCR, which ChatGPT also supports.

## Local verification

```sh
pnpm exec wrangler types --env staging
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p test/tsconfig.json
pnpm run test:staging
pnpm exec vitest run
```

Tests run the actual OAuth Provider and actual local Miniflare KV. Only GitHub token/user HTTP responses are mocked: these tests establish the local integration contract, not actual GitHub login or ChatGPT UI compatibility. No real client secret is required to run them. Wrangler may warn that OAuth secrets are missing from `.dev.vars.staging`; test-only bindings supply fictitious credentials inside the isolated test runtime.

Covered cases include metadata discovery, S256 PKCE, browser-bound consent, denial, HTML escaping, invalid redirects/resources/scopes, another GitHub identity, missing callback state, token exchange, code replay, scope narrowing, refresh rotation, token expiry, account allowlist changes, static-token refusal, and authenticated MCP Tools/Events including event callback verification.

For a manual browser login, use a separate development GitHub OAuth App and a stable HTTPS tunnel. Set the local `OAUTH_ISSUER` to that origin and register its exact `/oauth/github/callback` URI. Secure browser cookies and canonical-origin checks mean plain HTTP localhost is not a manual OAuth login setup. No tunnel or OAuth App was created by this task.

## Deployment preparation (separate approval required)

1. Create an isolated staging KV namespace and replace the local placeholder in `env.staging.kv_namespaces`. Never reuse a production namespace.
2. Create a dedicated staging GitHub OAuth App with the callback above; enable MFA on Nora's GitHub account. Verify Nora's numeric account ID and configure the three new secrets.
3. Check the exact ChatGPT redirect URI and update the allowlist if necessary.
4. After review and explicit deployment approval, deploy only `--env staging`. The current remote staging deployment uses OAuth; production retains its existing authentication.
5. In ChatGPT custom MCP setup, enter `https://personal-ai-os-staging.noradev.workers.dev/mcp` and select **OAuth**. DCR supplies the ChatGPT-facing client credentials; GitHub client credentials belong only in Worker secrets. If the UI offers optional predefined client fields, leave them empty for DCR. Rescan/recreate the connection if cached discovery is stale.
6. Complete consent and GitHub login as Nora. Confirm metadata discovery, client registration, authorization, token exchange and authenticated `events/list` before attempting subscription.
7. Obtain the actual MCP Events receiver origin, configure `MCP_CALLBACK_ORIGIN`, then verify subscription challenge, signed delivery and ChatGPT response. No event delivery is implied by successful OAuth.

## Remaining review items

- The local implementation phase did not alter remote resources. During the subsequently authorized deployment preparation, an isolated staging KV was created (see deployment preparation record below). GitHub OAuth and ChatGPT authorization remain unverified.
- Only Nora can receive grants, but the DCR/consent routes are public protocol endpoints. Before a broader rollout, apply staging-specific rate limiting to registration and authorization to control KV abuse.
- The provider uses eventually consistent KV. Its consent/state helpers are single-use under normal operation, but simultaneous requests from the same browser may race; this is a documented provider limitation. Review whether stronger storage is needed beyond this private staging MVP.
- GitHub is used as a login identity only. Revoking the GitHub App does not by itself revoke a separately issued MCP grant. Revoke MCP credentials through the provider's published `revocation_endpoint` (the token endpoint), change the allowlisted account ID to stop access/refresh, or wait for the fixed grant expiry.
- Keep credentials out of logs, URLs and Notion. The application emits generic auth errors and suppresses provider diagnostic logs. Authorization rejection diagnostics contain only a fixed stage and safe OAuth error code, never request parameters or error descriptions.

## GET authorization 400 fix — local only (2026-10-20)

Task: [修复 ChatGPT OAuth 授权 GET /authorize 返回 400](https://app.notion.com/p/3ff5fa82815981cd90acd187295aa203).

### Evidence and root cause

- Read-only inspection of the existing browser error page showed that ChatGPT sent the staging **origin**, without `/mcp`, as its `resource`. This corrects the task's initial description of that parameter. No full authorization URL, state, challenge, cookie or token is included in this record.
- Live protected-resource metadata still advertises the canonical `/mcp` resource; its authorization-server issuer matches the staging origin. The configured staging KV namespace is `e4f50472d5be477a99e22260d71973ed`. Read-only KV checks found both ChatGPT DCR clients present, with the exact stable redirect URI, `authorization_code` / `refresh_token`, `code`, and public-client authentication `none`. They are not missing or expired at inspection time. This does not rule out transient KV propagation at registration time.
- Provider 1.2.3 `parseAuthRequest()` calls `resolveAuthorizationRequestResource()`. An origin indicator does not match the configured narrower `/mcp` resource and throws `AuthorizationError` with code `invalid_target`, **before** `describeConsent()` or `beginConsent()`. The generic catch previously hid that distinction. A direct-provider regression now reproduces this exact stage/code locally.
- The original smoke test used `/mcp`, so it missed the observed origin-only request structure. OpenAI's [authentication guide](https://developers.openai.com/plugins/build/auth) describes resource indicators through authorization and token exchange; the browser observation is the evidence for this connection's differing value. Cloudflare's [authorization-server contract](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md) explains resource validation.

### Minimal fix and simple example

`src/staging.ts` applies a staging-only compatibility boundary before calling the provider. One exact origin-only indicator is mapped to the existing canonical `/mcp` resource in GET `/authorize` and form-encoded POST `/oauth/token` (code exchange and refresh). No other origin, arbitrary path, query, fragment or mixed resource list is rewritten. Metadata, stored grant audience and protected MCP route remain `/mcp`; this does not issue an origin-wide token or register a second resource.

Example: ChatGPT says “I want to connect to this staging server” using the root origin. Previously the server rejected it because it expected the specific MCP endpoint. Now the exact known server alias is translated to `/mcp`, and the existing PKCE, consent, GitHub account, scope and audience checks continue normally. Another server's origin is still rejected.

Separately, the consent page now uses `Referrer-Policy: same-origin`. The old `no-referrer` policy makes browser non-CORS form POSTs serialize Origin as `null` under the [Fetch Standard](https://fetch.spec.whatwg.org/#append-a-request-origin-header), conflicting with strict POST Origin verification. The strict verifier still rejects null/missing/foreign origins, and cross-origin Referer remains suppressed. This is a concrete adjacent browser-flow defect, not proof of the historical first `Invalid origin` request, whose method/headers were not captured.

### Verification and remaining approval

- Red/green evidence: the new observed-origin end-to-end test failed on the original code (`GET /authorize` returned 400 instead of 200), then passed with the compatibility boundary.
- Both source and test TypeScript checks pass. Staging suite: 4 files / 30 tests pass; original-entry suite: 2 files / 13 tests pass (overlapping suites, not 43 unique tests).
- Tests exercise actual local KV/provider, with GitHub HTTP mocked: origin and canonical resources, narrow stored grant, code exchange, refresh, Tools/Events, malformed resources, PKCE, consent binding, strict Origin, callback state, denial, token replay/expiry, scope/account restrictions and sanitized stage/code diagnostics.
- No binding changes, migrations, remote writes, secret uploads or deployments were needed. Production code entry, Worker, D1 and webhook are unchanged. Existing live staging version remains `f9346d68-9195-491a-a20d-c60bf7987fa1` (last deployment record; this task did not redeploy).
- After Nora separately approves staging deployment: deploy only `--env staging`, recreate/retry the ChatGPT OAuth connection, confirm consent GET 200 and browser POST with valid Origin, complete GitHub login as Nora, verify token exchange plus `tools/list` and `events/list`, refresh and negative credentials. Check only sanitized stage/code diagnostics if rejection persists. Do not capture full authorization URLs or credentials.
- Real ChatGPT/GitHub login remains unverified until that approved online run. Actual MCP Events delivery also still requires the real callback origin; OAuth success alone does not verify signed delivery. If the worker later hosts multiple resources, remove/review the single-resource alias rather than extending it generically.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Cloudflare OAuth Provider](https://github.com/cloudflare/workers-oauth-provider), [consent helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md), [upstream sign-in helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md), [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Deployment preparation record (2026-10-19)

- Direct inspection of ChatGPT's Add custom MCP server → Advanced OAuth settings displayed `https://chatgpt.com/connector/oauth/6Y1OB3Z7yE3p` while metadata discovery failed against the previous static-Bearer deployment. This exact URI was added alongside the stable URI. After OAuth deployment, retry discovery and recheck the displayed URI; the server's RFC 9207 metadata may select the stable URI instead. No wildcard was added, and no ChatGPT plugin was created during this inspection.

- Authorized deployment preparation created remote KV `staging-personal-ai-os-staging-oauth` (`e4f50472d5be477a99e22260d71973ed`) and replaced the placeholder in the staging config.
- `gh api user` verified authenticated account `norafu-dev`, numeric ID `192425660`.
- Local and remote checks found no GitHub OAuth App client ID/secret configured. The deployment waits for those credentials and the exact ChatGPT OAuth redirect URI; do not publish the fail-closed 503 version in place of the currently functioning staging version.
- GitHub App setup: name `Personal AI OS Staging`; homepage `https://personal-ai-os-staging.noradev.workers.dev`; callback `https://personal-ai-os-staging.noradev.workers.dev/oauth/github/callback`.
- Store App credentials only in ignored `.dev.vars.staging` or upload directly to staging Worker secrets. Do not send them through chat, Notion or Git.
- No OAuth deployment, remote D1 migration or production changes were performed during this preparation step.

## OAuth deployment verification (2026-10-19)

- Final Worker version: `f9346d68-9195-491a-a20d-c60bf7987fa1`; MCP URL: `https://personal-ai-os-staging.noradev.workers.dev/mcp`.

- The three real GitHub OAuth settings were verified locally without printing their values and uploaded with the existing five staging secrets. Nora's allowed GitHub ID is `192425660`.
- `wrangler deploy --env staging` deployed the OAuth entry point with independent staging KV and D1. No D1 migration was needed.
- Public checks: health 200; RFC 9728 resource metadata 200; authorization-server metadata 200 with S256, DCR and RFC 9207 issuer identification.
- Missing, invalid and previous static MCP tokens all receive 401 with an OAuth discovery challenge.
- A public-client DCR smoke test returned 201; an unapproved redirect returned 400. S256 authorization returned the protected consent page (200, X-Frame-Options DENY). No user grant or token was created by these smoke tests.
- ChatGPT's actual Add custom MCP server dialog successfully rediscovered the metadata and selected DCR. With discovery complete, the displayed OAuth redirect became `https://chatgpt.com/connector_platform_oauth_redirect`. The temporary callback-ID URI observed before discovery was removed from the allowlist.
- The ChatGPT dialog is left prepared with DCR selected. No plugin was created and no account consent was submitted. Nora must finish the real login; event subscription/delivery is still pending the actual event callback origin.
