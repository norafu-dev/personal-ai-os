import { processNotionEvent, type NotionEventHandler } from './notion-event';

type Env = {
	DB: D1Database;
};

type PendingEvent = {
	id: string;
};

export async function retryNotionEvents(env: Env, handleEvent?: NotionEventHandler): Promise<void> {
	const { results } = await env.DB.prepare(
		`
    SELECT id
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
			await processNotionEvent(env.DB, event.id, handleEvent);
		} catch (error) {
			console.error('Cron retry failed:', event.id, error);
		}
	}
}
