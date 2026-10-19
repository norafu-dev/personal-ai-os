import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('staging environment', () => {
	it('selects the staging bindings and applies all local D1 migrations', async () => {
		expect(env.ENVIRONMENT).toBe('staging');

		const tables = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('webhook_events', 'mcp_event_subscriptions', 'mcp_event_deliveries') ORDER BY name",
		).all<{ name: string }>();

		expect(tables.results.map(({ name }) => name)).toEqual([
			'mcp_event_deliveries',
			'mcp_event_subscriptions',
			'webhook_events',
		]);
	});
});
