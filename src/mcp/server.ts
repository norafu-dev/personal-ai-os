import { McpServer } from '@modelcontextprotocol/server';
import type { Client } from '@notionhq/client';
import * as z from 'zod/v4';
import {
	PRIORITIES,
	TASK_OWNERS,
	TASK_STATUSES,
	TASK_TYPES,
	ToolError,
	isNotionDate,
	listCalendar,
	listTasks,
	saveCalendarEvent,
	saveTask,
} from '../notion/tools';

const notionDate = z.string().refine(isNotionDate, 'Use YYYY-MM-DD or an ISO date-time with offset, e.g. 2026-10-22T09:00:00+09:00');

async function run(work: () => Promise<unknown>) {
	try {
		return { content: [{ type: 'text' as const, text: JSON.stringify(await work()) }] };
	} catch (error) {
		// Refusals are shown to the model verbatim; Notion/API failures only by code.
		const message = error instanceof ToolError
			? error.message
			: `Notion request failed (${(error as { code?: string })?.code ?? 'unknown_error'})`;
		if (!(error instanceof ToolError)) console.error('MCP tool failed:', (error as { code?: string })?.code ?? 'unknown_error');
		return { isError: true, content: [{ type: 'text' as const, text: message }] };
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
			description: 'List tasks from Nora\'s Notion AI 协作队列. By default returns open tasks (not 已完成/已归档), soonest due first.',
			inputSchema: z.object({
				statuses: z.array(z.enum(TASK_STATUSES)).optional().describe('Only these statuses (overrides include_closed)'),
				include_closed: z.boolean().optional().describe('Include 已完成 and 已归档 tasks'),
				due_on_or_before: notionDate.optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(async () => ({ tasks: await listTasks(notion, input) })),
	);

	server.registerTool(
		'save_task',
		{
			title: 'Create or update a task',
			description:
				'Create a task (omit page_id; title required) or update one (page_id from list_tasks; only given fields change). ' +
				'Tasks are never deleted: use status 已归档. Tasks marked needs_confirmation cannot be set to 已完成 — use 待评审 and ask Nora. ' +
				'Use needs_confirmation for anything that needs Nora\'s decision.',
			inputSchema: z.object({
				page_id: z.string().min(1).optional(),
				title: z.string().min(1).max(2000).optional(),
				status: z.enum(TASK_STATUSES).optional(),
				type: z.enum(TASK_TYPES).optional(),
				priority: z.enum(PRIORITIES).optional(),
				owner: z.enum(TASK_OWNERS).optional(),
				due: notionDate.nullable().optional().describe('null clears the due date'),
				next_step: z.string().max(2000).optional(),
				needs_confirmation: z.literal(true).optional().describe('Flag for Nora\'s confirmation; AI cannot clear it'),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (input) => run(async () => ({ task: await saveTask(notion, input) })),
	);

	server.registerTool(
		'list_calendar',
		{
			title: 'List calendar events',
			description: 'List events from Nora\'s Notion 日程 that overlap a time window. Times are Asia/Tokyo (+09:00) unless an offset is given.',
			inputSchema: z.object({
				start: notionDate,
				end: notionDate.describe('Inclusive when a plain date'),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (input) => run(async () => ({ events: await listCalendar(notion, input) })),
	);

	server.registerTool(
		'save_calendar_event',
		{
			title: 'Create or move a calendar event',
			description:
				'Create an event (omit page_id; title and start required) or update one (page_id from list_calendar). ' +
				'Moving start without end keeps the duration. Refuses locked (锁定) events and any overlap with another timed event. ' +
				'Events are never deleted. The first full schedule for a period must be confirmed by Nora before you write it.',
			inputSchema: z.object({
				page_id: z.string().min(1).optional(),
				title: z.string().min(1).max(2000).optional(),
				start: notionDate.optional(),
				end: notionDate.nullable().optional(),
				priority: z.enum(PRIORITIES).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (input) => run(() => saveCalendarEvent(notion, input)),
	);

	return server;
}
