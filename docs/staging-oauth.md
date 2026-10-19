# Staging OAuth (local implementation, awaiting review)

Staging has a separate entry point, `src/staging.ts`. It uses Cloudflare's maintained `@cloudflare/workers-oauth-provider` 1.2.3, rather than implementing authorization codes, token storage or refresh itself. Production continues to enter through `src/index.ts` and retains its existing Bearer authentication. This change has not been deployed.

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
| `OAUTH_KV` | staging-only KV binding | Independent namespace `staging-personal-ai-os-staging-oauth`, ID `e4f50472d5be477a99e22260d71973ed`; created for deployment preparation, not yet attached by a deployed OAuth version |
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
4. After review and explicit deployment approval, deploy only `--env staging`. The existing remote deployment still runs the previous static-Bearer version until that happens.
5. In ChatGPT custom MCP setup, enter `https://personal-ai-os-staging.noradev.workers.dev/mcp` and select **OAuth**. DCR supplies the ChatGPT-facing client credentials; GitHub client credentials belong only in Worker secrets. If the UI offers optional predefined client fields, leave them empty for DCR. Rescan/recreate the connection if cached discovery is stale.
6. Complete consent and GitHub login as Nora. Confirm metadata discovery, client registration, authorization, token exchange and authenticated `events/list` before attempting subscription.
7. Obtain the actual MCP Events receiver origin, configure `MCP_CALLBACK_ORIGIN`, then verify subscription challenge, signed delivery and ChatGPT response. No event delivery is implied by successful OAuth.

## Remaining review items

- The local implementation phase did not alter remote resources. During the subsequently authorized deployment preparation, an isolated staging KV was created (see deployment preparation record below). GitHub OAuth and ChatGPT authorization remain unverified.
- Only Nora can receive grants, but the DCR/consent routes are public protocol endpoints. Before a broader rollout, apply staging-specific rate limiting to registration and authorization to control KV abuse.
- The provider uses eventually consistent KV. Its consent/state helpers are single-use under normal operation, but simultaneous requests from the same browser may race; this is a documented provider limitation. Review whether stronger storage is needed beyond this private staging MVP.
- GitHub is used as a login identity only. Revoking the GitHub App does not by itself revoke a separately issued MCP grant. Revoke MCP credentials through the provider's published `revocation_endpoint` (the token endpoint), change the allowlisted account ID to stop access/refresh, or wait for the fixed grant expiry.
- Keep credentials out of logs, URLs and Notion. The application emits generic auth errors and suppresses provider diagnostic logs.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [Cloudflare OAuth Provider](https://github.com/cloudflare/workers-oauth-provider), [consent helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md), [upstream sign-in helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md), [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Deployment preparation record (2026-10-19)

- Authorized deployment preparation created remote KV `staging-personal-ai-os-staging-oauth` (`e4f50472d5be477a99e22260d71973ed`) and replaced the placeholder in the staging config.
- `gh api user` verified authenticated account `norafu-dev`, numeric ID `192425660`.
- Local and remote checks found no GitHub OAuth App client ID/secret configured. The deployment waits for those credentials and the exact ChatGPT OAuth redirect URI; do not publish the fail-closed 503 version in place of the currently functioning staging version.
- GitHub App setup: name `Personal AI OS Staging`; homepage `https://personal-ai-os-staging.noradev.workers.dev`; callback `https://personal-ai-os-staging.noradev.workers.dev/oauth/github/callback`.
- Store App credentials only in ignored `.dev.vars.staging` or upload directly to staging Worker secrets. Do not send them through chat, Notion or Git.
- No OAuth deployment, remote D1 migration or production changes were performed during this preparation step.
