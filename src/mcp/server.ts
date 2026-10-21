import { McpServer } from '@modelcontextprotocol/server';
import type { Client } from '@notionhq/client';
import * as z from 'zod/v4';
import { PRIORITIES, STATUSES, ToolError, isNotionDate, listCalendar, listTasks, saveTask } from '../notion/tools';

const notionDate = z.string().refine(isNotionDate, 'Use YYYY-MM-DD or an ISO date-time with offset, e.g. 2026-10-22T09:00:00+09:00');

async function run(work: () => Promise<unknown>) {
	try {
		return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] };
	} catch (error) {
		// Refusals are shown to the model verbatim; other failures only by code or error class.
		if (error instanceof ToolError) return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
		const { code, name, status, message } = (error ?? {}) as { code?: string; name?: string; status?: number; message?: string };
		const kind = code ?? name ?? 'unknown_error';
		// Notion and runtime error messages do not contain the token; truncate anyway.
		console.error('MCP tool failed:', { kind, status, message: String(message ?? '').slice(0, 200) });
		return { isError: true, content: [{ type: 'text' as const, text: `Notion request failed (${kind})` }] };
	}
}

export function createMcpServer(notion: Client) {
	const server = new McpServer({
		name: 'personal-ai-os',
		version: '0.2.0',
	});

	server.registerTool(
		'list_tasks',
		{
			title: 'List tasks',
			description:
				'List tasks from Nora\'s Notion 日程 database (it holds both tasks and scheduled events). ' +
				'By default returns unfinished items (Status is not Done), with or without a date, earliest first.',
			inputSchema: z.object({
				statuses: z.array(z.enum(STATUSES)).optional().describe('Only these statuses (overrides include_done)'),
				include_done: z.boolean().optional().describe('Include Done items'),
				due_on_or_before: notionDate.optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(async () => ({ tasks: await listTasks(notion, input) })),
	);

	server.registerTool(
		'list_calendar',
		{
			title: 'List schedule for a time window',
			description: 'List 日程 items whose date overlaps a time window, including Done ones. Times are Asia/Tokyo (+09:00) unless an offset is given.',
			inputSchema: z.object({
				start: notionDate,
				end: notionDate.describe('Inclusive when a plain date'),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(async () => ({ items: await listCalendar(notion, input) })),
	);

	server.registerTool(
		'save_task',
		{
			title: 'Create, update or schedule a task',
			description:
				'Create a 日程 item (omit page_id; title required) or update one (page_id from list_tasks/list_calendar; only given fields change). ' +
				'start/end: YYYY-MM-DD for all-day, or a date-time with offset for a time slot; start null removes the date. ' +
				'Moving start without end keeps the duration. Refuses to change the title or time of locked (锁定) items, and refuses any overlap ' +
				'with another unfinished timed item. Nothing is ever deleted: mark it Done instead. ' +
				'The first full schedule for a period must be confirmed by Nora before you write it.',
			inputSchema: z.object({
				page_id: z.string().min(1).optional(),
				title: z.string().min(1).max(2000).optional(),
				start: notionDate.nullable().optional(),
				end: notionDate.nullable().optional(),
				status: z.enum(STATUSES).optional(),
				priority: z.enum(PRIORITIES).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (input) => run(async () => ({ task: await saveTask(notion, input) })),
	);

	return server;
}
