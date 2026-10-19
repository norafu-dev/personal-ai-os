# Personal AI OS staging

The `staging` Wrangler environment resolves to the Worker name `personal-ai-os-staging`. Its `DB` binding is named `personal-ai-os-staging-db` and intentionally has no remote `database_id` yet. This prevents an accidental remote migration or deployment from targeting production.

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

Copy the returned UUID into `env.staging.d1_databases[0].database_id`, then configure each staging secret independently:

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
