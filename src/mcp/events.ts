import { NOTION_CONFIG } from '../config/notion';
import type { StandardNotionEvent } from '../types/notion-event';

export const MCP_EVENT_NAME = 'notion.page_properties_updated';
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 5;

type JsonRecord = Record<string, unknown>;
type Fetcher = typeof fetch;

export type McpEventsEnv = {
	DB: D1Database;
	MCP_CALLBACK_ORIGIN: string;
};

type Subscription = {
	id: string;
	owner_id: string;
	event_name: string;
	arguments_json: string;
	callback_url: string;
	signing_secret: string;
	previous_signing_secret: string | null;
	previous_secret_until: string | null;
	expires_at: string;
	active: number;
	verified_at: string;
};

type Delivery = {
	subscription_id: string;
	event_id: string;
	payload_json: string;
	attempts: number;
	callback_url: string;
	signing_secret: string;
	previous_signing_secret: string | null;
	previous_secret_until: string | null;
};

export class McpEventError extends Error {
	constructor(
		public readonly code: number,
		message: string,
		public readonly data?: { reason: string },
	) {
		super(message);
	}
}

function record(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
	throw new McpEventError(-32602, message);
}

function parseArguments(value: unknown): { data_source_id: string; page_id?: string } {
	if (!record(value) || Object.keys(value).some((key) => !['data_source_id', 'page_id'].includes(key))) {
		return invalid('Invalid event arguments');
	}
	if (typeof value.data_source_id !== 'string' || !NOTION_CONFIG.managedDataSourceIds.has(value.data_source_id)) {
		return invalid('Data source is not available for this event');
	}
	if (value.page_id !== undefined && (typeof value.page_id !== 'string' || value.page_id.length === 0)) {
		return invalid('page_id must be a nonempty string');
	}
	return {
		data_source_id: value.data_source_id,
		...(value.page_id === undefined ? {} : { page_id: value.page_id as string }),
	};
}

function parseEventParams(value: unknown, requireSecret: boolean) {
	if (!record(value) || value.name !== MCP_EVENT_NAME || !record(value.delivery)) {
		return invalid('Unsupported event or delivery');
	}
	const args = parseArguments(value.arguments);
	const delivery = value.delivery;
	if (delivery.mode !== 'webhook' || typeof delivery.url !== 'string') {
		return invalid('A webhook URL is required');
	}
	if (requireSecret && (typeof delivery.secret !== 'string' || !validSigningSecret(delivery.secret))) {
		return invalid('A whsec_ signing secret containing 24–64 bytes is required');
	}
	return {
		args,
		url: delivery.url,
		secret: requireSecret ? (delivery.secret as string) : undefined,
		ttlMs: value.ttlMs,
		cursor: value.cursor,
	};
}

function validSigningSecret(secret: string): boolean {
	if (!secret.startsWith('whsec_')) return false;
	const encoded = secret.slice(6);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false;
	try {
		const decoded = atob(encoded);
		return decoded.length >= 24 && decoded.length <= 64 && btoa(decoded) === encoded;
	} catch {
		return false;
	}
}

function validateCallbackUrl(urlString: string, allowedOrigin: string): void {
	let url: URL;
	let allowed: URL;
	try {
		url = new URL(urlString);
		allowed = new URL(allowedOrigin);
	} catch {
		return invalid('Invalid callback URL or configured origin');
	}
	if (
		url.protocol !== 'https:' ||
		allowed.protocol !== 'https:' ||
		allowed.origin !== allowedOrigin ||
		url.origin !== allowed.origin ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== '' ||
		url.hostname === 'localhost' ||
		url.hostname.endsWith('.local') ||
		url.hostname.endsWith('.') ||
		url.hostname.startsWith('[') ||
		/^\d+(?:\.\d+){3}$/.test(url.hostname)
	) {
		return invalid('Callback URL must use the configured public HTTPS origin');
	}
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return difference === 0;
}

async function subscriptionId(owner: string, url: string, argsJson: string): Promise<string> {
	const input = `${owner}\n${url}\n${MCP_EVENT_NAME}\n${argsJson}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return `sub_${Array.from(new Uint8Array(digest).slice(0, 24), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function signStandardWebhook(secret: string, id: string, timestamp: string, body: string): Promise<string> {
	const keyBytes = Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

async function signedPost(
	url: string,
	allowedOrigin: string,
	subscription: Pick<Subscription, 'id' | 'signing_secret' | 'previous_signing_secret' | 'previous_secret_until'>,
	id: string,
	body: string,
	webhookFetch: Fetcher,
): Promise<Response> {
	validateCallbackUrl(url, allowedOrigin);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signatures = [await signStandardWebhook(subscription.signing_secret, id, timestamp, body)];
	if (subscription.previous_signing_secret && subscription.previous_secret_until && subscription.previous_secret_until > new Date().toISOString()) {
		signatures.push(await signStandardWebhook(subscription.previous_signing_secret, id, timestamp, body));
	}
	return webhookFetch(url, {
		method: 'POST',
		redirect: 'error',
		signal: AbortSignal.timeout(10_000),
		headers: {
			'content-type': 'application/json',
			'webhook-id': id,
			'webhook-timestamp': timestamp,
			'webhook-signature': signatures.join(' '),
			'X-MCP-Subscription-Id': subscription.id,
		},
		body,
	});
}

async function verifyCallback(subscription: Pick<Subscription, 'id' | 'signing_secret' | 'previous_signing_secret' | 'previous_secret_until'>, url: string, origin: string, webhookFetch: Fetcher): Promise<void> {
	const challenge = crypto.randomUUID();
	let response: Response;
	try {
		response = await signedPost(url, origin, subscription, `msg_verification_${crypto.randomUUID()}`, JSON.stringify({ type: 'verification', challenge }), webhookFetch);
	} catch (error) {
		if (error instanceof McpEventError) throw error;
		throw new McpEventError(-32015, 'Callback verification failed', { reason: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'connection_failed' });
	}
	if (!response.ok) {
		throw new McpEventError(-32015, 'Callback verification failed', { reason: 'challenge_failed' });
	}
	let echoed: unknown;
	try {
		echoed = await response.json();
	} catch {
		throw new McpEventError(-32015, 'Callback verification failed', { reason: 'challenge_failed' });
	}
	if (!record(echoed) || typeof echoed.challenge !== 'string' || !constantTimeEqual(challenge, echoed.challenge)) {
		throw new McpEventError(-32015, 'Callback verification failed', { reason: 'challenge_failed' });
	}
}

export function listMcpEvents() {
	return {
		events: [{
			name: MCP_EVENT_NAME,
			description: 'A managed Notion page changed its properties. Filter by data source and optionally page.',
			delivery: ['webhook'],
			inputSchema: {
				type: 'object',
				properties: {
					data_source_id: { type: 'string', description: 'Managed Notion data source ID' },
					page_id: { type: 'string', description: 'Optional Notion page ID' },
				},
				required: ['data_source_id'],
				additionalProperties: false,
			},
			payloadSchema: {
				type: 'object',
				properties: {
					page_id: { type: 'string' },
					data_source_id: { type: 'string' },
					updated_property_ids: { type: 'array', items: { type: 'string' } },
				},
				required: ['page_id', 'data_source_id'],
				additionalProperties: false,
			},
		}],
	};
}

export async function subscribeMcpEvent(env: McpEventsEnv, owner: string, params: unknown, webhookFetch: Fetcher = fetch) {
	const parsed = parseEventParams(params, true);
	validateCallbackUrl(parsed.url, env.MCP_CALLBACK_ORIGIN);
	if (parsed.ttlMs !== undefined && parsed.ttlMs !== null && (!Number.isSafeInteger(parsed.ttlMs) || (parsed.ttlMs as number) <= 0)) {
		return invalid('ttlMs must be a positive integer or null');
	}
	if (parsed.cursor !== undefined && parsed.cursor !== null && typeof parsed.cursor !== 'string') {
		return invalid('cursor must be a string or null');
	}
	const argsJson = JSON.stringify(parsed.args);
	const id = await subscriptionId(owner, parsed.url, argsJson);
	const existing = await env.DB.prepare('SELECT * FROM mcp_event_subscriptions WHERE id = ?').bind(id).first<Subscription>();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + Math.min((parsed.ttlMs as number | null | undefined) ?? DEFAULT_TTL_MS, MAX_TTL_MS)).toISOString();
	const freshVerification = existing?.active === 1 && existing.signing_secret === parsed.secret && new Date(existing.verified_at).getTime() > now.getTime() - 10 * 60 * 1000;
	if (!freshVerification) {
		await verifyCallback({ id, signing_secret: parsed.secret!, previous_signing_secret: null, previous_secret_until: null }, parsed.url, env.MCP_CALLBACK_ORIGIN, webhookFetch);
	}
	const previousSecret = existing?.signing_secret !== parsed.secret ? existing?.signing_secret ?? null : existing?.previous_signing_secret ?? null;
	const previousUntil = previousSecret ? new Date(now.getTime() + 5 * 60 * 1000).toISOString() : null;
	await env.DB.prepare(
		`INSERT INTO mcp_event_subscriptions
		 (id, owner_id, event_name, arguments_json, callback_url, signing_secret, previous_signing_secret, previous_secret_until, expires_at, active, verified_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(id) DO UPDATE SET
		 signing_secret = excluded.signing_secret,
		 previous_signing_secret = excluded.previous_signing_secret,
		 previous_secret_until = excluded.previous_secret_until,
		 expires_at = excluded.expires_at,
		 active = 1,
		 verified_at = excluded.verified_at,
		 updated_at = CURRENT_TIMESTAMP`,
	).bind(id, owner, MCP_EVENT_NAME, argsJson, parsed.url, parsed.secret, previousSecret, previousUntil, expiresAt, now.toISOString()).run();
	return { id, refreshBefore: expiresAt, cursor: null, truncated: false };
}

export async function unsubscribeMcpEvent(env: McpEventsEnv, owner: string, params: unknown): Promise<Record<string, never>> {
	const parsed = parseEventParams(params, false);
	validateCallbackUrl(parsed.url, env.MCP_CALLBACK_ORIGIN);
	const id = await subscriptionId(owner, parsed.url, JSON.stringify(parsed.args));
	await env.DB.prepare('UPDATE mcp_event_subscriptions SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?')
		.bind(id, owner).run();
	await env.DB.prepare("UPDATE mcp_event_deliveries SET status = 'abandoned' WHERE subscription_id = ? AND status IN ('pending', 'failed')")
		.bind(id).run();
	return {};
}

export async function enqueueMcpEventDeliveries(db: D1Database, event: StandardNotionEvent, receivedAt: string): Promise<void> {
	if (!NOTION_CONFIG.managedDataSourceIds.has(event.dataSourceId)) return;
	const { results } = await db.prepare(
		`SELECT id, arguments_json FROM mcp_event_subscriptions
		 WHERE event_name = ? AND active = 1 AND expires_at > ?`,
	).bind(MCP_EVENT_NAME, new Date().toISOString()).all<{ id: string; arguments_json: string }>();
	const timestamp = new Date(receivedAt.endsWith('Z') ? receivedAt : `${receivedAt.replace(' ', 'T')}Z`).toISOString();
	const payload = JSON.stringify({
		eventId: event.eventId,
		name: MCP_EVENT_NAME,
		timestamp,
		data: {
			page_id: event.pageId,
			data_source_id: event.dataSourceId,
			...(event.updatedPropertyIds === undefined ? {} : { updated_property_ids: event.updatedPropertyIds }),
		},
		cursor: null,
	});
	if (new TextEncoder().encode(payload).byteLength > 262_144) throw new Error('Event payload exceeds 256 KiB');
	for (const subscription of results) {
		const args = JSON.parse(subscription.arguments_json) as { data_source_id: string; page_id?: string };
		if (args.data_source_id !== event.dataSourceId || (args.page_id && args.page_id !== event.pageId)) continue;
		await db.prepare('INSERT OR IGNORE INTO mcp_event_deliveries (subscription_id, event_id, payload_json) VALUES (?, ?, ?)')
			.bind(subscription.id, event.eventId, payload).run();
	}
}

export async function deliverPendingMcpEvents(env: McpEventsEnv, webhookFetch: Fetcher = fetch): Promise<void> {
	const { results } = await env.DB.prepare(
		`SELECT d.subscription_id, d.event_id FROM mcp_event_deliveries d
		 JOIN mcp_event_subscriptions s ON s.id = d.subscription_id
		 WHERE s.active = 1 AND s.expires_at > ? AND d.attempts < ?
		 AND ((d.status IN ('pending', 'failed') AND d.next_attempt_at <= CURRENT_TIMESTAMP)
		   OR (d.status = 'delivering' AND d.claimed_at < datetime('now', '-2 minutes')))
		 ORDER BY d.created_at ASC LIMIT 20`,
	).bind(new Date().toISOString(), MAX_DELIVERY_ATTEMPTS).all<{ subscription_id: string; event_id: string }>();
	for (const candidate of results) {
		const claim = await env.DB.prepare(
			`UPDATE mcp_event_deliveries SET status = 'delivering', attempts = attempts + 1, claimed_at = CURRENT_TIMESTAMP
			 WHERE subscription_id = ? AND event_id = ? AND attempts < ?
			 AND ((status IN ('pending', 'failed') AND next_attempt_at <= CURRENT_TIMESTAMP)
			   OR (status = 'delivering' AND claimed_at < datetime('now', '-2 minutes')))`,
		).bind(candidate.subscription_id, candidate.event_id, MAX_DELIVERY_ATTEMPTS).run();
		if (claim.meta.changes === 0) continue;
		const row = await env.DB.prepare(
			`SELECT d.subscription_id, d.event_id, d.payload_json, d.attempts,
			 s.callback_url, s.signing_secret, s.previous_signing_secret, s.previous_secret_until
			 FROM mcp_event_deliveries d JOIN mcp_event_subscriptions s ON s.id = d.subscription_id
			 WHERE d.subscription_id = ? AND d.event_id = ? AND s.active = 1 AND s.expires_at > ?`,
		).bind(candidate.subscription_id, candidate.event_id, new Date().toISOString()).first<Delivery>();
		if (!row) {
			await env.DB.prepare("UPDATE mcp_event_deliveries SET status = 'abandoned' WHERE subscription_id = ? AND event_id = ?")
				.bind(candidate.subscription_id, candidate.event_id).run();
			continue;
		}
		let status: number | null = null;
		let error: string | null = null;
		try {
			const response = await signedPost(row.callback_url, env.MCP_CALLBACK_ORIGIN, {
				id: row.subscription_id,
				signing_secret: row.signing_secret,
				previous_signing_secret: row.previous_signing_secret,
				previous_secret_until: row.previous_secret_until,
			}, row.event_id, row.payload_json, webhookFetch);
			status = response.status;
			if (response.ok) {
				await env.DB.prepare("UPDATE mcp_event_deliveries SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP, last_http_status = ?, last_error = NULL WHERE subscription_id = ? AND event_id = ? AND status = 'delivering'")
					.bind(status, row.subscription_id, row.event_id).run();
				continue;
			}
			error = `Callback returned HTTP ${status}`;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const terminal = status === 410 || status === 413 || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) || row.attempts >= MAX_DELIVERY_ATTEMPTS;
		const backoffSeconds = Math.min(60 * 60, 2 ** row.attempts * 60);
		await env.DB.prepare(
			`UPDATE mcp_event_deliveries SET status = ?, last_http_status = ?, last_error = ?,
			 next_attempt_at = datetime('now', '+' || ? || ' seconds')
			 WHERE subscription_id = ? AND event_id = ? AND status = 'delivering'`,
		).bind(terminal ? 'abandoned' : 'failed', status, error, backoffSeconds, row.subscription_id, row.event_id).run();
	}
}
