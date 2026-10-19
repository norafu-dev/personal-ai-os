import { NOTION_CONFIG } from '../config/notion';
import { parseStandardNotionEvent, type StandardNotionEvent } from '../types/notion-event';
import { enqueueMcpEventDeliveries } from '../mcp/events';

export type NotionEventHandler = (event: StandardNotionEvent) => Promise<void>;

type StoredEvent = {
	id: string;
	event_type: string;
	entity_id: string;
	event_payload: string | null;
	received_at: string;
};

export const handleNotionEventLocally: NotionEventHandler = async (event) => {
	console.log('Notion event completed locally; AI delivery was not attempted:', {
		eventId: event.eventId,
		eventType: event.eventType,
		pageId: event.pageId,
		dataSourceId: event.dataSourceId,
		updatedPropertyIds: event.updatedPropertyIds,
	});
};

function readStandardEvent(storedEvent: StoredEvent): StandardNotionEvent {
	if (storedEvent.event_payload === null) {
		throw new Error('Stored event is missing its standardized payload');
	}

	let parsedPayload: unknown;

	try {
		parsedPayload = JSON.parse(storedEvent.event_payload);
	} catch {
		throw new Error('Stored event has an invalid standardized payload');
	}

	const event = parseStandardNotionEvent(parsedPayload);

	if (
		event === null ||
		event.eventId !== storedEvent.id ||
		event.eventType !== storedEvent.event_type ||
		event.pageId !== storedEvent.entity_id ||
		!NOTION_CONFIG.managedDataSourceIds.has(event.dataSourceId)
	) {
		throw new Error('Stored event metadata does not match its standardized payload');
	}

	return event;
}

export async function processNotionEvent(
	db: D1Database,
	eventId: string,
	handleEvent: NotionEventHandler = handleNotionEventLocally,
): Promise<void> {
	// 只有 pending、failed 状态的事件可以被认领
	// 通过条件 UPDATE 避免并发重复处理
	const claimed = await db
		.prepare(
			`
		UPDATE webhook_events
		SET status = 'processing',
			attempts = attempts + 1,
			processing_started_at = CURRENT_TIMESTAMP,
			last_error = NULL
		WHERE id = ?
		  AND attempts < 3
		  AND (
			status IN ('pending', 'failed')
			OR (
			  status = 'processing'
			  AND (
				processing_started_at IS NULL
				OR processing_started_at < datetime('now', '-10 minutes')
			  )
			)
		  )
	  `,
		)
		.bind(eventId)
		.run();

	if (claimed.meta.changes === 0) {
		console.log('Event already claimed or completed:', eventId);
		return;
	}

	try {
		const storedEvent = await db
			.prepare(
				`SELECT id, event_type, entity_id, event_payload, received_at
				 FROM webhook_events
				 WHERE id = ?`,
			)
			.bind(eventId)
			.first<StoredEvent>();

		if (storedEvent === null) {
			throw new Error('Claimed event could not be loaded');
		}

		const event = readStandardEvent(storedEvent);
		await handleEvent(event);
		await enqueueMcpEventDeliveries(db, event, storedEvent.received_at);

		await db
			.prepare(
				`
      UPDATE webhook_events
      SET status = 'completed',
          processed_at = CURRENT_TIMESTAMP,
          last_error = NULL
      WHERE id = ? AND status = 'processing'
    `,
			)
			.bind(eventId)
			.run();

		console.log('Event completed locally:', eventId);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);

		await db
			.prepare(
				`
      UPDATE webhook_events
      SET status = 'failed',
          last_error = ?
      WHERE id = ? AND status = 'processing'
    `,
			)
			.bind(errorMessage, eventId)
			.run();

		console.error('Event failed:', {
			id: eventId,
			error: errorMessage,
		});

		throw error;
	}
}
