# Personal AI OS staging

OAuth now uses a separate staging entry point and was deployed on 2026-10-19. See [staging-oauth.md](staging-oauth.md) for verification and ChatGPT setup. The initial deployment record below describes the previous static Bearer version; the current staging MCP requires OAuth.

The `staging` Wrangler environment resolves to the Worker name `personal-ai-os-staging`. Its `DB` binding is the independent `personal-ai-os-staging-db` database (`9a0612b1-0109-429b-ad79-bf3653342833`), never the production D1 database.

## Local setup

1. Create the ignored local secret file:

   ```sh
   cp .dev.vars.staging.example .dev.vars.staging
   ```

2. Replace every placeholder with staging-only values. Do not copy the production webhook secret or MCP token. `MCP_CALLBACK_ORIGIN` must be the exact HTTPS origin used by the staging ChatGPT callback.

3. Apply all migrations to the staging local D1 only:

   ```sh
   pnpm exec wrangler d1 migrations apply DB --local --env staging
   ```

4. Run the environment-specific tests:

   ```sh
   pnpm run test:staging
   ```

5. Start the local staging Worker:

   ```sh
   pnpm run dev:staging
   ```

6. In another terminal, send a synthetic Notion event through the real signature-verification route:

   ```sh
   pnpm run staging:event
   ```

   If Wrangler selected a port other than `8787`, pass the printed URL explicitly, for example:

   ```sh
   NOTION_TEST_URL=http://127.0.0.1:8788/webhooks/notion pnpm run staging:event
   ```

The sender refuses destinations that are not localhost or explicitly named staging. It does not add a test-only Worker route and therefore cannot bypass Notion signature validation.

## Local MCP checks

Use the staging-only token from `.dev.vars.staging` with `POST http://127.0.0.1:8787/mcp` (or Wrangler's printed port). Verify these methods in order:

1. `server/discover`
2. `events/list`
3. `events/subscribe` with a test callback that answers the challenge
4. Send the synthetic Notion event
5. Confirm the callback receives a signed `notion.page_properties_updated` payload
6. Confirm a repeated `eventId` is deduplicated and a callback `2xx` means accepted, not AI execution completed

The automated staging suite covers discovery, listing, authentication, callback challenge, subscription persistence, event filtering, D1 deduplication, exact-body HMAC signing, retry behavior, and unsubscribe behavior.

## Remote staging steps — approval required

Do not run these commands until Nora explicitly approves remote resource creation and deployment.

```sh
pnpm exec wrangler d1 create personal-ai-os-staging-db
```

If the staging database ever needs to be recreated, copy the returned UUID into `env.staging.d1_databases[0].database_id`. Configure each staging secret independently:

```sh
pnpm exec wrangler secret put NOTION_API_KEY --env staging
pnpm exec wrangler secret put NOTION_DATA_SOURCE_ID --env staging
pnpm exec wrangler secret put NOTION_WEBHOOK_SECRET --env staging
pnpm exec wrangler secret put MCP_AUTH_TOKEN --env staging
pnpm exec wrangler secret put MCP_CALLBACK_ORIGIN --env staging
```

After a separate approval, apply remote migrations and deploy only the named environment:

```sh
pnpm exec wrangler d1 migrations apply DB --remote --env staging
pnpm exec wrangler deploy --env staging
```

Never change the production Notion Connection Webhook target for this test. ChatGPT Work discovery and subscription remain blocked until the staging Worker and an HTTPS callback are available publicly.

## Deployment record (2026-10-19)

- Worker: `https://personal-ai-os-staging.noradev.workers.dev`
- MCP: `https://personal-ai-os-staging.noradev.workers.dev/mcp`
- Version: `8b2bc25f-56b5-4a75-868c-3b170519125f`
- Remote staging D1 migrations 0001–0005 applied successfully.
- Public checks: health 200, unauthenticated MCP 401, authenticated discovery and events list 200.
- Synthetic event `staging-38fbd106-18eb-44ac-b588-428b1cbe899c` persisted remotely with status `completed`, attempts 1.
- Five staging secrets uploaded; random MCP and webhook credentials are retained only in ignored `.dev.vars.staging`.
- `NOTION_API_KEY` is an intentionally unusable staging value: the current event pipeline does not read Notion. Configure a separately authorized integration before adding Notion read tools.
- `MCP_CALLBACK_ORIGIN` is still `https://callback.staging.example.com`, a placeholder. Replace it with the actual ChatGPT callback origin before subscription verification. No active subscriptions or successful remote callback deliveries have been claimed.
- ChatGPT connection must support the configured Bearer authentication; compatibility with the actual ChatGPT plugin connection remains to be verified.
- Production resources and the production Notion Webhook target were not changed.

## Events callback runtime fix — local only (2026-10-20)

Task: [实现 MCP Events 订阅与签名交付](https://app.notion.com/p/3fe5fa8281598110bb82e459498273a6).

- The shared `signedPost()` path used `redirect: 'error'` for both subscription verification and event delivery. Workers does not implement that mode: Request construction throws before sending. See the [current Workers Request contract](https://developers.cloudflare.com/workers/runtime-apis/request/#constructor). Earlier mocked responses bypassed that construction step.
- Changed only the redirect option to `manual`. The existing `response.ok` checks reject all 3xx: a redirect cannot verify a subscription or mark a delivery accepted. No Location is followed, even on the configured origin. Failed delivery attempts retain their numeric HTTP status and existing bounded retry behavior (up to 5 attempts, then abandoned). No changes to signatures, payload bytes, origin restrictions, authentication, expiry, D1 schema or secrets.
- Regression evidence: the new actual-workerd-Request test failed before the fix with callback verification failure, then passed after it. It independently verifies the HMAC of exact request bytes for both challenge and event delivery, and confirms 204 is recorded as accepted.
- Ten additional cases cover 301/302/303/307/308 to same-origin and foreign-origin destinations. Even a correct challenge echo on a 3xx is rejected without persisting a subscription. Delivery attempts go only to the original callback URL, never accept a 3xx, do not save Location/response-body values, and stop after the fifth failure.
- Example: a callback replies “307, send this signed event to another address.” The Worker does not send the event or signature there. Verification fails; an existing event delivery records HTTP 307 as failure and follows the original retry limit. A direct successful challenge plus a 2xx event response still works.
- Checks passed: source and test TypeScript; staging 4 files / 61 tests; original entry 2 files / 24 tests. These suites overlap; counts must not be added as unique tests. All requests/storage in these tests are local mocks/local D1, not evidence of public ChatGPT event reception.
- Scope: shared Events source is modified locally for both entry points, but **no Worker was deployed**, no remote D1/KV migration or secret update was performed, and the live production/Staging environments are unchanged. No binding changes required type regeneration.
- Next, after separate staging deployment approval: obtain the actual ChatGPT callback origin, confirm the isolated staging configuration, deploy only staging and validate subscription challenge, signed test-event delivery, ChatGPT response and Notion writeback. OAuth UI connection alone does not satisfy that end-to-end acceptance criterion.

## Events callback fix deployed and verified (2026-10-20)

- Nora explicitly approved staging deployment and verification. Deployed source `efb69be` with `pnpm exec wrangler deploy --env staging`; current version is `d9f199f5-1cab-40af-b919-ad87defcb5a1`.
- Independent staging KV/D1 retained. No migration, secret upload, production deployment or production Notion webhook change was performed.
- Public checks pass: health and both OAuth metadata documents 200, canonical issuer/resource preserved; `events/list`, `events/subscribe` and `tools/list` each reject both missing and invalid credentials with 401 plus metadata discovery challenge. These are negative-auth tests, not authenticated discovery/subscribe success.
- A signed synthetic queue event `staging-events-smoke-161ca269-83f1-47bf-81e4-bb7783dec5ae` passed the real staging webhook path. Remote D1 confirms `completed`, `attempts=1`, one record. Replayed signed event returns 200 / `duplicate:true`; incorrect signature returns 401. One clearly labeled synthetic audit event remains in staging D1; no real Notion page was modified.
- TypeScript source/test checks and full local suites rerun successfully: staging 61 tests / 4 files; original entry 24 tests / 2 files (overlap). Local challenge/signature/redirect tests use workerd requests and controlled transports; they do not prove a public receiver accepted an event.
- Remaining blocker: remote staging D1 has zero subscriptions and no deliveries. The local staging callback setting is still the placeholder `https://callback.staging.example.com`; this run did not replace the remote secret or invent a receiver. No authenticated RPC credential was available to this agent; authentication was not bypassed or read out of credential storage.
- Per [OpenAI MCP Events instructions](https://developers.openai.com/plugins/build/mcp-events), the next host-side step is to rescan the plugin if needed, then request a subscription in a ChatGPT Work chat (web, or desktop with Cloud selected). ChatGPT supplies the actual callback URL/signing secret. Confirm only its origin for the staging allowlist; never share its secret or full sensitive request. After configuring that exact verified origin, retry subscribe and verify challenge, signed delivery, ChatGPT response and Notion writeback. Until then, the end-to-end task remains blocked rather than complete.

## Empty ChatGPT tool list — isolated diagnostic (2026-10-20)

- Source task: [ChatGPT Work subscription acceptance](https://app.notion.com/p/3fe5fa8281598111a9f9d3e04d88d949). The installed personal plugin UI says there are no available tools. Its management page displays the staging origin, but this does not establish the actual registered MCP endpoint. The downloaded plugin archive contains only a cloud app reference and manifest, not an editable MCP URL. No refresh/rescan control was found in that personal dev-mode UI; do not invent one or delete the existing plugin.
- Added payload-level OAuth regression coverage in `test/oauth.spec.ts`: real local Provider/KV, consent, PKCE and authorization-code exchange issue an in-memory, resource-bound test token; only upstream GitHub HTTP is mocked. Modern `tools/list` returns a `get_projects` definition with an object input schema; `server/discover` independently advertises tools/events and `2026-07-28`; `events/list` independently returns `notion.page_properties_updated`. A separate legacy `2025-03-26` stateless request also lists `get_projects`, decoding the SSE response where needed.
- Example: this checks not merely that the server answers “200”, but that the reply actually contains the tool the client should display. Both modern and legacy local tool discovery pass. This narrows the investigation but does not prove the deployed ChatGPT OAuth session or endpoint is correct.
- Checks: source/test TypeScript pass; staging 4 files / 63 tests; original entry 2 files / 24 tests (overlapping suites, not 87 unique tests). Test credentials stay in local memory and are not printed or saved. The first sandboxed attempt could not start localhost workerd; rerunning with the required local runtime permissions passed.
- No runtime source, bindings, secrets or remote data changed. No deployment or plugin installation/removal was performed. Remote request tracing and the actual ChatGPT registered endpoint remain separate evidence requirements; absent traces must not be interpreted as proof that ChatGPT never sent a request.
- Remote trace attempt: the direct Wrangler tail invocation reported a Cloudflare API request failure and never established a connection. Raw output was suppressed; disk logging was disabled for the direct diagnostic. Consequently there is no reliable remote method/status trace or historical request evidence from this run. Plugin-directory search also did not return this personal plugin; the search is non-exhaustive and does not contradict its installed UI state.
- Next: obtain an authenticated host-side discovery trace or, with Nora's specific approval, create a parallel staging test connection to the exact `/mcp` endpoint while retaining the old plugin. Do not extract existing OAuth tokens, disable auth or broaden callback/redirect allowlists to diagnose discovery.


## Staging Events diagnostics — local implementation (2026-10-21)

- Implemented the reviewed per-request diagnostics, enabled only by the Staging entry plus `MCP_EVENTS_DIAGNOSTICS=1`. Only fixed enums/status codes/internal correlation are emitted; no URL, token, secret, body, identity, or raw exception is passed to the logger. Logger failure cannot change the result.
- Staging configuration sets 100% sampling and `observability.logs.invocation_logs=false`. Generated binding types were refreshed. These are local configuration edits only; no deployment has occurred.
- Local validation: source/test TypeScript; Staging 5 files/99 tests; original entry 2 files/24 tests (overlapping suites); Staging bundle dry run. Includes a real local OAuth-to-subscribe trace, with a controlled callback transport rather than a real Work subscription.
- Review the actual diff and confirm an existing safe log-reading channel before separate deployment approval. The old Observability 403 remains unresolved. Synthetic platform-envelope redaction checks and real Work end-to-end acceptance remain unverified. The broader security findings are tracked in `docs/staging-events-diagnostics-review.md` and are not changed by this diagnostic patch.
- Disabling the application diagnostic switch stops new observer records, but needs a separately approved configuration deployment. Do not restore automatic URL-bearing invocation logs as a default rollback.
