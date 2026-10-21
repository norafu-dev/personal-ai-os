import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTION_CONFIG } from '../src/config/notion';
import {
	MCP_EVENT_NAME,
	deliverPendingMcpEvents,
	enqueueMcpEventDeliveries,
	subscribeMcpEvent,
	unsubscribeMcpEvent,
} from '../src/mcp/events';
import { handleMcpHttp } from '../src/mcp/http';
import type { StandardNotionEvent } from '../src/types/notion-event';

const origin = 'https://callback.example.com';
const url = `${origin}/mcp-events/test`;
const secret = `whsec_${btoa('12345678901234567890123456789012')}`;
const dataSourceId = [...NOTION_CONFIG.managedDataSourceIds][0];
const queueDataSourceId = '95af6fad-798f-4d0a-b370-356646a5745d';
const eventsEnv = { DB: env.DB, MCP_CALLBACK_ORIGIN: origin };
const httpEnv = { ...eventsEnv, MCP_AUTH_TOKEN: 'test-mcp-token', NOTION_API_KEY: 'test-notion-key' };

function params(overrides: Record<string, unknown> = {}) {
	return {
		name: MCP_EVENT_NAME,
		arguments: { data_source_id: dataSourceId },
		delivery: { mode: 'webhook', url, secret },
		...overrides,
	};
}

const verificationFetch = vi.fn<typeof fetch>(async (input, init) => {
	const request = new Request(input, init);
	const body = JSON.parse(new TextDecoder().decode(await request.arrayBuffer())) as { challenge: string };
	return Response.json({ challenge: body.challenge });
});

async function signedRequest(input: RequestInfo | URL, init?: RequestInit) {
	// Exercise workerd's Request constructor, which rejects redirect:error.
	// Returning a mocked response alone would hide that runtime incompatibility.
	const request = new Request(input, init);
	expect(request.redirect).toBe('manual');
	expect(request.url).toBe(url);
	const body = new TextDecoder().decode(await request.arrayBuffer());
	const id = request.headers.get('webhook-id')!;
	const timestamp = request.headers.get('webhook-timestamp')!;
	const signature = request.headers.get('webhook-signature')!.slice(3);
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('12345678901234567890123456789012'),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	expect(await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(signature), char => char.charCodeAt(0)),
		new TextEncoder().encode(`${id}.${timestamp}.${body}`))).toBe(true);
	return { request, body: JSON.parse(body) as { challenge?: string; eventId?: string } };
}

function event(id: string, source = dataSourceId): StandardNotionEvent {
	return {
		eventId: id,
		eventType: 'page.properties_updated',
		pageId: 'page-1',
		dataSourceId: source,
		updatedPropertyIds: ['status'],
	};
}

async function rpc(method: string, id = 1): Promise<Response> {
	return handleMcpHttp(new Request('https://worker.example.com/mcp', {
		method: 'POST',
		headers: {
			authorization: 'Bearer test-mcp-token',
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'MCP-Protocol-Version': '2026-07-28',
			'Mcp-Method': method,
		},
		body: JSON.stringify({
			jsonrpc: '2.0', id, method,
			params: {
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
					'io.modelcontextprotocol/clientCapabilities': {},
				},
			},
		}),
	}), httpEnv);
}

describe('MCP Events', () => {
	beforeEach(async () => {
		verificationFetch.mockClear();
		await env.DB.prepare('DELETE FROM mcp_event_deliveries').run();
		await env.DB.prepare('DELETE FROM mcp_event_subscriptions').run();
	});

	it('uses real workerd Requests for signed challenge and event delivery', async () => {
		const transport = vi.fn<typeof fetch>(async (input, init) => {
			const { body } = await signedRequest(input, init);
			return body.challenge ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 204 });
		});
		const subscription = await subscribeMcpEvent(eventsEnv, 'nora', params(), transport);
		await enqueueMcpEventDeliveries(env.DB, event('runtime-request'), '2026-10-19 10:00:00');
		await deliverPendingMcpEvents(eventsEnv, transport);
		expect(transport).toHaveBeenCalledTimes(2);
		const delivered = await env.DB.prepare('SELECT subscription_id, status, attempts, last_http_status FROM mcp_event_deliveries')
			.first<{ subscription_id: string; status: string; attempts: number; last_http_status: number }>();
		expect(delivered).toMatchObject({ subscription_id: subscription.id, status: 'accepted', attempts: 1, last_http_status: 204 });
	});

	it.each([301, 302, 303, 307, 308].flatMap(status => [
		{ status, destination: 'same-origin', location: `${origin}/moved?private-location=value` },
		{ status, destination: 'foreign-origin', location: 'https://untrusted.example/collect?private-location=value' },
	]))('refuses $status redirects to $destination for challenge and delivery', async ({ status, location }) => {
		const redirecting = vi.fn<typeof fetch>(async (input, init) => {
			const { body } = await signedRequest(input, init);
			// Even a correct echo must not make a redirect a valid verification.
			return Response.json({ challenge: body.challenge, private: 'private-response-body' }, { status, headers: { location } });
		});
		await expect(subscribeMcpEvent(eventsEnv, 'nora', params(), redirecting))
			.rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
		expect(redirecting).toHaveBeenCalledTimes(1);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM mcp_event_subscriptions').first('count')).toBe(0);

		await subscribeMcpEvent(eventsEnv, 'nora', params(), verificationFetch);
		await enqueueMcpEventDeliveries(env.DB, event('redirected-delivery'), '2026-10-19 10:00:00');
		redirecting.mockClear();
		await deliverPendingMcpEvents(eventsEnv, redirecting);
		const failed = await env.DB.prepare('SELECT status, attempts, last_http_status, last_error, accepted_at FROM mcp_event_deliveries')
			.first<{ status: string; attempts: number; last_http_status: number; last_error: string; accepted_at: string | null }>();
		expect(failed).toMatchObject({ status: 'failed', attempts: 1, last_http_status: status,
			last_error: `Callback returned HTTP ${status}`, accepted_at: null });
		expect(redirecting).toHaveBeenCalledTimes(1);
		// Preserve existing bounded retries; each attempt goes only to the original URL.
		for (let attempt = 2; attempt <= 5; attempt++) {
			await env.DB.prepare("UPDATE mcp_event_deliveries SET next_attempt_at = datetime('now', '-1 second')").run();
			await deliverPendingMcpEvents(eventsEnv, redirecting);
		}
		await deliverPendingMcpEvents(eventsEnv, redirecting);
		expect(redirecting).toHaveBeenCalledTimes(5);
		expect(await env.DB.prepare('SELECT status, attempts, accepted_at FROM mcp_event_deliveries').first())
			.toMatchObject({ status: 'abandoned', attempts: 5, accepted_at: null });
	});

	it('requires authentication and advertises the MCP 2.0 event', async () => {
		const unauthorized = await handleMcpHttp(new Request('https://worker.example.com/mcp', { method: 'POST' }), httpEnv);
		expect(unauthorized.status).toBe(401);
		const discovered = await (await rpc('server/discover')).json() as { result: { supportedVersions: string[]; capabilities: Record<string, unknown> } };
		expect(discovered.result.supportedVersions).toContain('2026-07-28');
		expect(discovered.result.capabilities).toHaveProperty('events');
		const listed = await (await rpc('events/list')).json() as { result: { events: { name: string }[] } };
		expect(listed.result.events[0]?.name).toBe(MCP_EVENT_NAME);
		const tools = await (await rpc('tools/list')).json() as { result?: { tools?: { name: string }[] }; error?: unknown };
		expect(tools.error).toBeUndefined();
		expect(tools.result?.tools?.some((tool) => tool.name === 'list_tasks')).toBe(true);
	});

	it('verifies the callback, rejects bad challenges, and refreshes idempotently', async () => {
		const first = await subscribeMcpEvent(eventsEnv, 'nora', params(), verificationFetch);
		expect(first).toMatchObject({ cursor: null, truncated: false });
		expect(verificationFetch).toHaveBeenCalledTimes(1);
		const request = verificationFetch.mock.calls[0]?.[1];
		expect(request?.redirect).toBe('manual');
		expect(new Headers(request?.headers).get('webhook-signature')).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
		const second = await subscribeMcpEvent(eventsEnv, 'nora', params(), verificationFetch);
		expect(second.id).toBe(first.id);
		expect(verificationFetch).toHaveBeenCalledTimes(1);
		const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM mcp_event_subscriptions').first<{ count: number }>();
		expect(count?.count).toBe(1);

		await expect(subscribeMcpEvent(eventsEnv, 'nora', params({ delivery: { mode: 'webhook', url: `${origin}/other`, secret } }),
			async () => Response.json({ challenge: 'wrong' }))).rejects.toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
		const afterFailure = await env.DB.prepare('SELECT COUNT(*) AS count FROM mcp_event_subscriptions').first<{ count: number }>();
		expect(afterFailure?.count).toBe(1);
	});

	it('rejects unsafe destinations and invalid signing keys before callback access', async () => {
		await expect(subscribeMcpEvent(eventsEnv, 'nora', params({ delivery: { mode: 'webhook', url: 'http://127.0.0.1/private', secret } }), verificationFetch))
			.rejects.toMatchObject({ code: -32602 });
		await expect(subscribeMcpEvent(eventsEnv, 'nora', params({ delivery: { mode: 'webhook', url, secret: 'whsec_bad' } }), verificationFetch))
			.rejects.toMatchObject({ code: -32602 });
		expect(verificationFetch).not.toHaveBeenCalled();
	});

	it('enqueues only matching events, signs exact payload, retries, and stops after unsubscribe', async () => {
		const subscription = await subscribeMcpEvent(eventsEnv, 'nora', params(), verificationFetch);
		await enqueueMcpEventDeliveries(env.DB, event('wrong-source', queueDataSourceId), '2026-10-19 10:00:00');
		await enqueueMcpEventDeliveries(env.DB, event('matching'), '2026-10-19 10:00:00');
		await enqueueMcpEventDeliveries(env.DB, event('matching'), '2026-10-19 10:00:00');
		const initial = await env.DB.prepare('SELECT event_id, payload_json FROM mcp_event_deliveries').first<{ event_id: string; payload_json: string }>();
		expect(initial?.event_id).toBe('matching');
		expect(JSON.parse(initial!.payload_json)).toMatchObject({ eventId: 'matching', name: MCP_EVENT_NAME, data: { data_source_id: dataSourceId } });

		const transient = vi.fn<typeof fetch>(async () => new Response('try again', { status: 503 }));
		await deliverPendingMcpEvents(eventsEnv, transient);
		expect(transient).toHaveBeenCalledTimes(1);
		const failed = await env.DB.prepare('SELECT status, attempts FROM mcp_event_deliveries').first<{ status: string; attempts: number }>();
		expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
		await env.DB.prepare("UPDATE mcp_event_deliveries SET next_attempt_at = datetime('now', '-1 second')").run();

		const accepted = vi.fn<typeof fetch>(async (_input, init) => {
			const headers = new Headers(init?.headers);
			const timestamp = headers.get('webhook-timestamp')!;
			const body = String(init?.body);
			const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('12345678901234567890123456789012'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
			const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`matching.${timestamp}.${body}`));
			expect(headers.get('webhook-signature')).toBe(`v1,${btoa(String.fromCharCode(...new Uint8Array(digest)))}`);
			expect(headers.get('webhook-id')).toBe('matching');
			expect(headers.get('X-MCP-Subscription-Id')).toBe(subscription.id);
			return new Response(null, { status: 204 });
		});
		await deliverPendingMcpEvents(eventsEnv, accepted);
		expect(accepted).toHaveBeenCalledTimes(1);
		const delivered = await env.DB.prepare('SELECT status, attempts, last_http_status FROM mcp_event_deliveries').first<{ status: string; attempts: number; last_http_status: number }>();
		expect(delivered).toMatchObject({ status: 'accepted', attempts: 2, last_http_status: 204 });

		await unsubscribeMcpEvent(eventsEnv, 'nora', { name: MCP_EVENT_NAME, arguments: { data_source_id: dataSourceId }, delivery: { mode: 'webhook', url } });
		await enqueueMcpEventDeliveries(env.DB, event('after-unsubscribe'), '2026-10-19 10:01:00');
		const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM mcp_event_deliveries').first<{ count: number }>();
		expect(count?.count).toBe(1);
	});
});
