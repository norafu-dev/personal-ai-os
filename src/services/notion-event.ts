import { Client } from '@notionhq/client';

export async function processNotionEvent(db: D1Database, notionApiKey: string, eventId: string, pageId: string): Promise<void> {
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
			  AND processing_started_at < datetime('now', '-10 minutes')
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
		const notion = new Client({
			auth: notionApiKey,
			dangerouslyAllowBrowser: true,
		});

		const page = await notion.pages.retrieve({
			page_id: pageId,
		});

		if (page.object === 'page' && 'properties' in page) {
			const priority = page.properties.Priority;

			console.log('Notion page updated:', {
				pageId: page.id,
				priority: priority?.type === 'select' ? priority.select?.name : null,
			});
		}

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

		console.log('Event completed:', eventId);
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
