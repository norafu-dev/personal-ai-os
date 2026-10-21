import type { Client } from '@notionhq/client';
import { NOTION_CONFIG } from '../config/notion';

// Property names in Notion. Keep in sync with the AI 协作队列 and 日程 data sources.
export const TASK_PROPS = {
	title: '事项',
	status: '状态',
	type: '类型',
	priority: '优先级',
	owner: '处理方',
	initiator: '发起方',
	due: '截止时间',
	nextStep: '下一步',
	needsConfirmation: '需要人工确认',
	lastEdited: '最近活动',
} as const;

export const CALENDAR_PROPS = {
	title: 'Name',
	date: 'Date',
	priority: 'Priority',
	// Optional checkbox. Until it exists in Notion, no event counts as locked.
	locked: '锁定',
} as const;

export const TASK_STATUSES = ['收件箱', '已就绪', '处理中', '待评审', '受阻', '已完成', '已归档'] as const;
export const TASK_TYPES = ['请求', '决策', '任务', '进展', '结果', '风险'] as const;
export const PRIORITIES = ['高', '中', '低'] as const;
export const TASK_OWNERS = ['Nora', 'Codex', 'ChatGPT', '共同'] as const;
const CLOSED_STATUSES = ['已完成', '已归档'];

/** A refusal or bad input the model should see and can act on. */
export class ToolError extends Error {}

type Props = Record<string, any>;
type Page = { id: string; url: string; parent: Props; properties: Props; last_edited_time: string };

function text(prop: any): string {
	const parts = prop?.title ?? prop?.rich_text ?? [];
	return parts.map((part: { plain_text: string }) => part.plain_text).join('');
}

function richText(content: string) {
	return [{ type: 'text' as const, text: { content: content.slice(0, 2000) } }];
}

function compact<T extends Props>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

async function loadOwnedPage(notion: Client, pageId: string, dataSourceId: string): Promise<Page> {
	let page: Page;
	try {
		page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as Page;
	} catch {
		throw new ToolError(`Page ${pageId} was not found or is not shared with the integration`);
	}
	// Only pages inside the expected data source may be edited through these tools.
	if (page.parent?.data_source_id !== dataSourceId) throw new ToolError(`Page ${pageId} is not in the expected Notion database`);
	return page;
}

// ==================== Tasks (AI 协作队列) ====================

export type TaskSummary = {
	id: string;
	url: string;
	title: string;
	status: string | null;
	type: string | null;
	priority: string | null;
	owner: string | null;
	initiator: string | null;
	due: string | null;
	next_step: string;
	needs_confirmation: boolean;
	last_edited: string;
};

function toTask(page: Page): TaskSummary {
	const p = page.properties;
	return {
		id: page.id,
		url: page.url,
		title: text(p[TASK_PROPS.title]),
		status: p[TASK_PROPS.status]?.status?.name ?? null,
		type: p[TASK_PROPS.type]?.select?.name ?? null,
		priority: p[TASK_PROPS.priority]?.select?.name ?? null,
		owner: p[TASK_PROPS.owner]?.select?.name ?? null,
		initiator: p[TASK_PROPS.initiator]?.select?.name ?? null,
		due: p[TASK_PROPS.due]?.date?.start ?? null,
		next_step: text(p[TASK_PROPS.nextStep]),
		needs_confirmation: p[TASK_PROPS.needsConfirmation]?.checkbox === true,
		last_edited: page.last_edited_time,
	};
}

export type ListTasksInput = { statuses?: string[]; include_closed?: boolean; due_on_or_before?: string; limit?: number };

export async function listTasks(notion: Client, input: ListTasksInput): Promise<TaskSummary[]> {
	const and: Props[] = [];
	if (input.statuses?.length) {
		and.push({ or: input.statuses.map((name) => ({ property: TASK_PROPS.status, status: { equals: name } })) });
	} else if (!input.include_closed) {
		for (const name of CLOSED_STATUSES) and.push({ property: TASK_PROPS.status, status: { does_not_equal: name } });
	}
	if (input.due_on_or_before) and.push({ property: TASK_PROPS.due, date: { on_or_before: input.due_on_or_before } });
	const response = await notion.dataSources.query({
		data_source_id: NOTION_CONFIG.tasksDataSourceId,
		page_size: input.limit ?? 25,
		...(and.length ? { filter: { and } as any } : {}),
		sorts: [
			{ property: TASK_PROPS.due, direction: 'ascending' },
			{ timestamp: 'last_edited_time', direction: 'descending' },
		],
	});
	return (response.results as unknown as Page[]).map(toTask);
}

export type SaveTaskInput = {
	page_id?: string;
	title?: string;
	status?: string;
	type?: string;
	priority?: string;
	owner?: string;
	due?: string | null;
	next_step?: string;
	needs_confirmation?: true;
};

export async function saveTask(notion: Client, input: SaveTaskInput): Promise<TaskSummary> {
	const properties: Props = compact({
		[TASK_PROPS.title]: input.title === undefined ? undefined : { title: richText(input.title) },
		[TASK_PROPS.status]: input.status === undefined ? undefined : { status: { name: input.status } },
		[TASK_PROPS.type]: input.type === undefined ? undefined : { select: { name: input.type } },
		[TASK_PROPS.priority]: input.priority === undefined ? undefined : { select: { name: input.priority } },
		[TASK_PROPS.owner]: input.owner === undefined ? undefined : { select: { name: input.owner } },
		[TASK_PROPS.due]: input.due === undefined ? undefined : { date: input.due === null ? null : { start: input.due } },
		[TASK_PROPS.nextStep]: input.next_step === undefined ? undefined : { rich_text: richText(input.next_step) },
		[TASK_PROPS.needsConfirmation]: input.needs_confirmation ? { checkbox: true } : undefined,
	});

	if (!input.page_id) {
		if (!input.title?.trim()) throw new ToolError('title is required when creating a task');
		const created = await notion.pages.create({
			parent: { type: 'data_source_id', data_source_id: NOTION_CONFIG.tasksDataSourceId },
			properties: {
				[TASK_PROPS.status]: { status: { name: '收件箱' } },
				[TASK_PROPS.type]: { select: { name: '任务' } },
				...properties,
				[TASK_PROPS.initiator]: { select: { name: 'ChatGPT' } },
			},
		});
		return toTask(created as unknown as Page);
	}

	const current = toTask(await loadOwnedPage(notion, input.page_id, NOTION_CONFIG.tasksDataSourceId));
	if (current.needs_confirmation && input.status === '已完成') {
		throw new ToolError('This task needs Nora\'s confirmation: set status to 待评审 instead of 已完成');
	}
	if (Object.keys(properties).length === 0) throw new ToolError('No fields to update');
	const updated = await notion.pages.update({ page_id: input.page_id, properties });
	return toTask(updated as unknown as Page);
}

// ==================== Calendar (日程) ====================

export type CalendarEvent = {
	id: string;
	url: string;
	title: string;
	start: string | null;
	end: string | null;
	all_day: boolean;
	priority: string | null;
	locked: boolean;
};

function toEvent(page: Page): CalendarEvent {
	const p = page.properties;
	const date = p[CALENDAR_PROPS.date]?.date;
	return {
		id: page.id,
		url: page.url,
		title: text(p[CALENDAR_PROPS.title]),
		start: date?.start ?? null,
		end: date?.end ?? null,
		all_day: typeof date?.start === 'string' && !date.start.includes('T'),
		priority: p[CALENDAR_PROPS.priority]?.select?.name ?? null,
		locked: p[CALENDAR_PROPS.locked]?.checkbox === true,
	};
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isNotionDate(value: string): boolean {
	return (DATE_ONLY.test(value) || DATE_TIME.test(value)) && !Number.isNaN(Date.parse(value));
}

/** Date-only values are read as Nora's local midnight. */
function instant(value: string): number {
	return Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00${NOTION_CONFIG.utcOffset}` : value);
}

function toOffsetTime(ms: number): string {
	const [sign, hours, minutes] = [NOTION_CONFIG.utcOffset[0], ...NOTION_CONFIG.utcOffset.slice(1).split(':').map(Number)];
	const offsetMs = (sign === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000;
	return new Date(ms + offsetMs).toISOString().slice(0, 19) + NOTION_CONFIG.utcOffset;
}

function overlaps(event: CalendarEvent, from: number, to: number): boolean {
	if (!event.start) return false;
	const start = instant(event.start);
	// All-day events cover the whole of their last day.
	const end = event.end ? instant(event.end) + (event.all_day ? 86_400_000 : 0) : start + (event.all_day ? 86_400_000 : 0);
	return start < to && (end > from || (end === start && start >= from));
}

async function queryEvents(notion: Client, from: number, to: number, limit = 100): Promise<CalendarEvent[]> {
	// Widen the Notion filter (multi-day events start earlier than the window), then filter exactly.
	const response = await notion.dataSources.query({
		data_source_id: NOTION_CONFIG.calendarDataSourceId,
		page_size: limit,
		filter: {
			and: [
				{ property: CALENDAR_PROPS.date, date: { on_or_after: new Date(from - 86_400_000 * 31).toISOString() } },
				{ property: CALENDAR_PROPS.date, date: { on_or_before: new Date(to + 86_400_000).toISOString() } },
			],
		} as any,
		sorts: [{ property: CALENDAR_PROPS.date, direction: 'ascending' }],
	});
	return (response.results as unknown as Page[]).map(toEvent).filter((event) => overlaps(event, from, to));
}

export async function listCalendar(notion: Client, input: { start: string; end: string; limit?: number }): Promise<CalendarEvent[]> {
	const from = instant(input.start);
	const to = instant(input.end) + (DATE_ONLY.test(input.end) ? 86_400_000 : 0);
	if (!(to > from)) throw new ToolError('end must be after start');
	return (await queryEvents(notion, from, to)).slice(0, input.limit ?? 50);
}

export type SaveEventInput = { page_id?: string; title?: string; start?: string; end?: string | null; priority?: string };

export async function saveCalendarEvent(
	notion: Client,
	input: SaveEventInput,
): Promise<{ event: CalendarEvent }> {
	let current: CalendarEvent | undefined;
	if (input.page_id) {
		current = toEvent(await loadOwnedPage(notion, input.page_id, NOTION_CONFIG.calendarDataSourceId));
		if (current.locked) throw new ToolError(`"${current.title}" is locked (锁定) and cannot be changed by AI`);
	} else if (!input.title?.trim() || !input.start) {
		throw new ToolError('title and start are required when creating an event');
	}

	const start = input.start ?? current?.start ?? null;
	let end = input.end === undefined ? current?.end ?? null : input.end;
	// Moving an event without a new end keeps its duration.
	if (input.start !== undefined && input.end === undefined && current?.start && current.end && start) {
		const shifted = instant(start) + (instant(current.end) - instant(current.start));
		end = DATE_ONLY.test(start) ? new Date(shifted + 86_400_000 / 2).toISOString().slice(0, 10) : toOffsetTime(shifted);
	}
	if (start && end !== null) {
		if (DATE_ONLY.test(start) !== DATE_ONLY.test(end)) throw new ToolError('start and end must both be dates or both be date-times');
		if (!(instant(end) > instant(start)) && !(DATE_ONLY.test(start) && end === start)) throw new ToolError('end must be after start');
	}

	// Never create a time conflict with another timed event. All-day events do not block time.
	if (start && !DATE_ONLY.test(start) && (input.start !== undefined || input.end !== undefined)) {
		const from = instant(start);
		const to = end ? instant(end) : from;
		const conflicts = (await queryEvents(notion, from, Math.max(to, from + 1)))
			.filter((event) => event.id !== current?.id && !event.all_day);
		if (conflicts.length) {
			throw new ToolError(`Time conflict with: ${conflicts.map((event) => `"${event.title}" (${event.start} – ${event.end ?? event.start})`).join('; ')}`);
		}
	}

	const properties: Props = compact({
		[CALENDAR_PROPS.title]: input.title === undefined ? undefined : { title: richText(input.title) },
		[CALENDAR_PROPS.date]: input.start === undefined && input.end === undefined ? undefined : { date: { start: start!, end } },
		[CALENDAR_PROPS.priority]: input.priority === undefined ? undefined : { select: { name: input.priority } },
	});

	if (!current) {
		const created = await notion.pages.create({
			parent: { type: 'data_source_id', data_source_id: NOTION_CONFIG.calendarDataSourceId },
			properties,
		});
		return { event: toEvent(created as unknown as Page) };
	}
	if (Object.keys(properties).length === 0) throw new ToolError('No fields to update');
	return { event: toEvent((await notion.pages.update({ page_id: current.id, properties })) as unknown as Page) };
}
