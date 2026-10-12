import { Hono } from 'hono';
import { verifyWebhookSignature } from '@notionhq/client';
import { processNotionEvent } from './services/notion-event';
import { retryNotionEvents } from './services/cron';

type Bindings = {
	NOTION_API_KEY: string;
	NOTION_DATA_SOURCE_ID: string;
	NOTION_WEBHOOK_SECRET: string;
	DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => {
	return c.text('Personal AI OS is running!');
});

app.get('/health', (c) => {
	return c.json({
		status: 'ok',
		service: 'personal-ai-os',
	});
});

app.post('/webhooks/notion', async (c) => {
	const rawBody = await c.req.text();
	const signature = c.req.header('x-notion-signature');

	if (!signature) {
		return c.json({ error: 'Missing signature' }, 401);
	}

	const isValid = await verifyWebhookSignature({
		body: rawBody,
		signature,
		verificationToken: c.env.NOTION_WEBHOOK_SECRET,
	});

	if (!isValid) {
		return c.json({ error: 'Invalid signature' }, 401);
	}

	const event = JSON.parse(rawBody);

	if (typeof event.id !== 'string' || typeof event.type !== 'string' || typeof event.entity?.id !== 'string') {
		return c.json({ error: 'Invalid event' }, 400);
	}

	// 将事件 ID 保存到 D1
	const result = await c.env.DB.prepare(
		`
	  INSERT OR IGNORE INTO webhook_events (
		id,
		event_type,
		entity_id
	  )
	  VALUES (?, ?, ?)
	`,
	)
		.bind(event.id, event.type, event.entity.id)
		.run();

	// 重复事件暂时直接跳过。
	// 后续由独立重试机制处理 failed / pending 事件。
	if (result.meta.changes === 0) {
		console.log('Duplicate event:', event.id);

		return c.json({
			received: true,
			duplicate: true,
		});
	}

	try {
		await processNotionEvent(c.env.DB, c.env.NOTION_API_KEY, event.id, event.entity.id);

		return c.json({
			received: true,
		});
	} catch (error) {
		console.error('Webhook processing failed:', error);

		// 返回 500，让 Notion 有机会重试投递。
		// 后续由 Cron 负责重试已经保存的 failed 事件。
		return c.json({ error: 'Processing failed' }, 500);
	}
});

export default {
	fetch: app.fetch,

	async scheduled(_controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
		await retryNotionEvents(env);
	},
};
