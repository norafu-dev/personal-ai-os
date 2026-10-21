import configuration from '../wrangler.jsonc?raw';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('staging environment', () => {
	it('keeps diagnostic logging configuration only in Staging', () => {
		const environmentStart = configuration.indexOf('"env":');
		const production = configuration.slice(0, environmentStart);
		const staging = configuration.slice(environmentStart);
		expect(environmentStart).toBeGreaterThan(0);
		expect(production).not.toContain('MCP_EVENTS_DIAGNOSTICS');
		expect(production).not.toContain('invocation_logs');
		expect(staging).toContain('"MCP_EVENTS_DIAGNOSTICS": "1"');
		expect(staging).toContain('"invocation_logs": false');
		expect(env.MCP_EVENTS_DIAGNOSTICS).toBe('1');
	});

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
