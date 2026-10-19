import { Hono } from 'hono';
import { verifyWebhookSignature } from '@notionhq/client';
import { processNotionEvent } from './services/notion-event';
import { retryNotionEvents } from './services/cron';
import { handleMcpHttp } from './mcp/http';
import { deliverPendingMcpEvents } from './mcp/events';
import { NOTION_CONFIG } from './config/notion';
import { parseNotionWebhookEvent } from './types/notion-event';

// Cloudflare Worker 环境变量
export type Bindings = {
	NOTION_API_KEY: string;
	NOTION_DATA_SOURCE_ID: string;
	NOTION_WEBHOOK_SECRET: string;
	MCP_AUTH_TOKEN: string;
	MCP_CALLBACK_ORIGIN: string;
	DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// ==================== 基础路由 ====================

app.get('/', (c) => {
	return c.text('Personal AI OS is running!');
});

app.get('/health', (c) => {
	return c.json({
		status: 'ok',
		service: 'personal-ai-os',
	});
});

// ==================== Notion Webhook ====================

app.post('/webhooks/notion', async (c) => {
	// 1. 获取原始请求内容
	const rawBody = await c.req.text();
	const signature = c.req.header('x-notion-signature');

	// 2. 检查签名
	if (!signature) {
		return c.json({ error: 'Missing signature' }, 401);
	}

	// 3. 验证是否来自 Notion
	const isValid = await verifyWebhookSignature({
		body: rawBody,
		signature,
		verificationToken: c.env.NOTION_WEBHOOK_SECRET,
	});

	if (!isValid) {
		return c.json({ error: 'Invalid signature' }, 401);
	}

	// 4. 解析事件
	let rawEvent: unknown;

	try {
		rawEvent = JSON.parse(rawBody);
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	// 5. 校验并标准化事件。只从 parent.data_source_id 读取 Data Source ID，
	// 避免把 page entity ID 误当成 Data Source ID。
	const parsedEvent = parseNotionWebhookEvent(rawEvent, NOTION_CONFIG.managedDataSourceIds);

	if (parsedEvent.kind === 'invalid') {
		return c.json({ error: 'Invalid event' }, 400);
	}

	if (parsedEvent.kind === 'ignored') {
		console.log('Ignored Notion event:', {
			reason: parsedEvent.reason,
			eventType: parsedEvent.eventType,
			dataSourceId: parsedEvent.dataSourceId,
		});

		return c.json({
			received: true,
			ignored: true,
			reason: parsedEvent.reason,
		});
	}
	const event = parsedEvent.event;

	// ==================== D1 事件存储 ====================

	// 6. 将事件保存到 D1，使用主键防止重复
	const result = await c.env.DB.prepare(
		`
        INSERT OR IGNORE INTO webhook_events (
            id,
            event_type,
			entity_id,
			event_payload
        )
		VALUES (?, ?, ?, ?)
    `,
	)
		.bind(event.eventId, event.eventType, event.pageId, JSON.stringify(event))
		.run();

	// 7. 检查重复事件
	if (result.meta.changes === 0) {
		console.log('Duplicate event:', event.eventId);

		return c.json({
			received: true,
			duplicate: true,
		});
	}

	// ==================== 事件处理 ====================

	// 8. 调用独立的事件处理函数
	try {
		await processNotionEvent(c.env.DB, event.eventId);
		c.executionCtx.waitUntil(deliverPendingMcpEvents(c.env));

		return c.json({
			received: true,
			status: 'completed',
			aiDelivery: 'queued',
		});
	} catch (error) {
		console.error('Webhook processing failed:', error);

		// 事件已经保存到 D1
		// 后续由 Cron 负责重试 failed / pending 事件
		return c.json(
			{
				error: 'Processing failed',
			},
			500,
		);
	}
});

// ==================== MCP Server ====================

app.all('/mcp', async (c) => {
	return handleMcpHttp(c.req.raw, c.env);
});

// ==================== Cloudflare Worker ====================

export default {
	// HTTP 请求入口
	fetch: app.fetch,

	// Cloudflare Cron Trigger 入口
	async scheduled(_controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
		await retryNotionEvents(env);
		await deliverPendingMcpEvents(env);
	},
};
