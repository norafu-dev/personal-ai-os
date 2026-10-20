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
