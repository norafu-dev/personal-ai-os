import { processNotionEvent } from './notion-event';

type Env = {
	DB: D1Database;
	NOTION_API_KEY: string;
};

type PendingEvent = {
	id: string;
	entity_id: string;
};

export async function retryNotionEvents(env: Env): Promise<void> {
	const { results } = await env.DB.prepare(
		`
    SELECT id, entity_id
    FROM webhook_events
    WHERE attempts < 3
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
    ORDER BY received_at ASC
    LIMIT 10
  `,
	).all<PendingEvent>();

	console.log('Retry candidates:', results.length);

	for (const event of results) {
		try {
			await processNotionEvent(env.DB, env.NOTION_API_KEY, event.id, event.entity_id);
		} catch (error) {
			console.error('Cron retry failed:', event.id, error);
		}
	}
}
