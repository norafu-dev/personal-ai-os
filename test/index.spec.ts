import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from 'cloudflare:test';
import { signWebhookPayload } from '@notionhq/client';
import { beforeEach, describe, it, expect } from 'vitest';
import worker from '../src/index';
import { NOTION_CONFIG } from '../src/config/notion';
import { retryNotionEvents } from '../src/services/cron';
import { processNotionEvent } from '../src/services/notion-event';
import type { StandardNotionEvent } from '../src/types/notion-event';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const webhookSecret = 'test-webhook-secret';

const testEnv: Env = {
	DB: env.DB,
	NOTION_API_KEY: 'test-notion-api-key',
	NOTION_DATA_SOURCE_ID: 'test-data-source-id',
	NOTION_WEBHOOK_SECRET: webhookSecret,
};

function webhookPayload({
	id,
	dataSourceId,
	updatedProperties = ['property-id'],
}: {
	id: string;
	dataSourceId: string;
	updatedProperties?: unknown;
}) {
	return {
		id,
		type: 'page.properties_updated',
		entity: {
			id: `page-${id}`,
			type: 'page',
		},
		data: {
			parent: {
				id: 'database-block-id',
				type: 'database',
				data_source_id: dataSourceId,
			},
			updated_properties: updatedProperties,
		},
	};
}

async function sendWebhook(payload: unknown): Promise<Response> {
	const body = JSON.stringify(payload);
	const signature = await signWebhookPayload({ body, verificationToken: webhookSecret });
	const request = new IncomingRequest('http://example.com/webhooks/notion', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-notion-signature': signature,
		},
		body,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	await waitOnExecutionContext(ctx);

	return response;
}

async function insertStandardEvent(event: StandardNotionEvent, status = 'pending'): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO webhook_events (id, event_type, entity_id, event_payload, status)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(event.eventId, event.eventType, event.pageId, JSON.stringify(event), status)
		.run();
}

describe('Personal AI OS worker', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM webhook_events').run();
	});

	it('responds with the service status (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe('Personal AI OS is running!');
	});

	it('responds with the service status (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toBe('Personal AI OS is running!');
	});

	it('accepts and persists standardized events for all managed data sources', async () => {
		for (const [index, dataSourceId] of [...NOTION_CONFIG.managedDataSourceIds].entries()) {
			const response = await sendWebhook(
				webhookPayload({
					id: `managed-${index}`,
					dataSourceId,
					updatedProperties: [`property-${index}`],
				}),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				received: true,
				status: 'completed',
				aiDelivery: 'queued',
			});
		}

		const { results } = await env.DB.prepare(
			'SELECT id, event_payload, status, attempts FROM webhook_events ORDER BY id',
		).all<{ id: string; event_payload: string; status: string; attempts: number }>();

		expect(results).toHaveLength(NOTION_CONFIG.managedDataSourceIds.size);
		for (const row of results) {
			const event = JSON.parse(row.event_payload) as StandardNotionEvent;
			expect(event.eventId).toBe(row.id);
			expect(NOTION_CONFIG.managedDataSourceIds.has(event.dataSourceId)).toBe(true);
			expect(event.updatedPropertyIds).toHaveLength(1);
			expect(row).toMatchObject({ status: 'completed', attempts: 1 });
		}
	});

	it('ignores unsupported event types and unmanaged data sources without queueing them', async () => {
		const unsupportedResponse = await sendWebhook({
			id: 'unsupported',
			type: 'page.content_updated',
		});
		expect(await unsupportedResponse.json()).toMatchObject({
			received: true,
			ignored: true,
			reason: 'unsupported_event_type',
		});

		const unmanagedResponse = await sendWebhook(
			webhookPayload({ id: 'unmanaged', dataSourceId: 'unmanaged-data-source' }),
		);
		expect(await unmanagedResponse.json()).toMatchObject({
			received: true,
			ignored: true,
			reason: 'unmanaged_data_source',
		});

		const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM webhook_events').first<{ count: number }>();
		expect(row?.count).toBe(0);
	});

	it('does not confuse the page ID with the data source ID', async () => {
		const managedDataSourceId = [...NOTION_CONFIG.managedDataSourceIds][0];
		const payload = webhookPayload({ id: managedDataSourceId, dataSourceId: 'unmanaged-data-source' });
		payload.entity.id = managedDataSourceId;

		const response = await sendWebhook(payload);
		expect(await response.json()).toMatchObject({ ignored: true, reason: 'unmanaged_data_source' });

		const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM webhook_events').first<{ count: number }>();
		expect(row?.count).toBe(0);
	});

	it('deduplicates repeated deliveries by event ID', async () => {
		const dataSourceId = [...NOTION_CONFIG.managedDataSourceIds][0];
		const payload = webhookPayload({ id: 'duplicate-event', dataSourceId });

		expect(await (await sendWebhook(payload)).json()).toMatchObject({ status: 'completed' });
		expect(await (await sendWebhook(payload)).json()).toMatchObject({ received: true, duplicate: true });

		const row = await env.DB.prepare(
			'SELECT COUNT(*) AS count, MAX(attempts) AS attempts FROM webhook_events WHERE id = ?',
		)
			.bind('duplicate-event')
			.first<{ count: number; attempts: number }>();
		expect(row).toMatchObject({ count: 1, attempts: 1 });
	});

	it('retries a failed event through Cron with the persisted metadata', async () => {
		const event: StandardNotionEvent = {
			eventId: 'retry-event',
			eventType: 'page.properties_updated',
			pageId: 'retry-page',
			dataSourceId: [...NOTION_CONFIG.managedDataSourceIds][0],
			updatedPropertyIds: ['status-property'],
		};
		await insertStandardEvent(event);

		await expect(
			processNotionEvent(env.DB, event.eventId, async () => {
				throw new Error('simulated processing failure');
			}),
		).rejects.toThrow('simulated processing failure');

		const failed = await env.DB.prepare('SELECT status, attempts FROM webhook_events WHERE id = ?')
			.bind(event.eventId)
			.first<{ status: string; attempts: number }>();
		expect(failed).toMatchObject({ status: 'failed', attempts: 1 });

		const retriedEvents: StandardNotionEvent[] = [];
		await retryNotionEvents({ DB: env.DB }, async (retriedEvent) => {
			retriedEvents.push(retriedEvent);
		});

		expect(retriedEvents).toEqual([event]);
		const completed = await env.DB.prepare('SELECT status, attempts FROM webhook_events WHERE id = ?')
			.bind(event.eventId)
			.first<{ status: string; attempts: number }>();
		expect(completed).toMatchObject({ status: 'completed', attempts: 2 });
	});

	it('handles historical rows without standardized metadata without crashing Cron', async () => {
		await env.DB.prepare('INSERT INTO webhook_events (id, event_type, entity_id) VALUES (?, ?, ?)')
			.bind('legacy-event', 'page.properties_updated', 'legacy-page')
			.run();

		await expect(retryNotionEvents({ DB: env.DB })).resolves.toBeUndefined();

		const row = await env.DB.prepare('SELECT status, attempts, last_error FROM webhook_events WHERE id = ?')
			.bind('legacy-event')
			.first<{ status: string; attempts: number; last_error: string }>();
		expect(row).toMatchObject({
			status: 'failed',
			attempts: 1,
			last_error: 'Stored event is missing its standardized payload',
		});
	});

	it('recovers a processing row whose claim timestamp is missing', async () => {
		const event: StandardNotionEvent = {
			eventId: 'missing-claim-time',
			eventType: 'page.properties_updated',
			pageId: 'stale-page',
			dataSourceId: [...NOTION_CONFIG.managedDataSourceIds][0],
		};
		await insertStandardEvent(event, 'processing');

		const recovered: StandardNotionEvent[] = [];
		await retryNotionEvents({ DB: env.DB }, async (retriedEvent) => {
			recovered.push(retriedEvent);
		});

		expect(recovered).toEqual([event]);
		const row = await env.DB.prepare('SELECT status, attempts FROM webhook_events WHERE id = ?')
			.bind(event.eventId)
			.first<{ status: string; attempts: number }>();
		expect(row).toMatchObject({ status: 'completed', attempts: 1 });
	});
});
