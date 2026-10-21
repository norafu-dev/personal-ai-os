import type { Client } from '@notionhq/client';
import { NOTION_CONFIG } from '../config/notion';

// Property names in Nora's 日程 data source, which holds both tasks and events.
export const SCHEDULE_PROPS = {
	title: 'Name',
	date: 'Date',
	priority: 'Priority',
	status: 'Status',
	// Locked items keep their title and time; AI may still update their status.
	locked: '锁定',
} as const;

export const STATUSES = ['Not started', 'In progress', 'Done'] as const;
export const PRIORITIES = ['高', '中', '低'] as const;
const DONE = 'Done';

/** A refusal or bad input the model should see and can act on. */
export class ToolError extends Error {}

type Props = Record<string, any>;
type Page = { id: string; url: string; parent: Props; properties: Props; last_edited_time: string };

export type ScheduleItem = {
	id: string;
	url: string;
	title: string;
	status: string | null;
	priority: string | null;
	start: string | null;
	end: string | null;
	all_day: boolean;
	locked: boolean;
	last_edited: string;
};

function text(prop: any): string {
	const parts = prop?.title ?? prop?.rich_text ?? [];
	return parts.map((part: { plain_text: string }) => part.plain_text).join('');
}

function toItem(page: Page): ScheduleItem {
	const p = page.properties;
	const date = p[SCHEDULE_PROPS.date]?.date;
	return {
		id: page.id,
		url: page.url,
		title: text(p[SCHEDULE_PROPS.title]),
		status: p[SCHEDULE_PROPS.status]?.status?.name ?? null,
		priority: p[SCHEDULE_PROPS.priority]?.select?.name ?? null,
		start: date?.start ?? null,
		end: date?.end ?? null,
		all_day: typeof date?.start === 'string' && !date.start.includes('T'),
		locked: p[SCHEDULE_PROPS.locked]?.checkbox === true,
		last_edited: page.last_edited_time,
	};
}

async function loadItem(notion: Client, pageId: string): Promise<ScheduleItem> {
	let page: Page;
	try {
		page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as Page;
	} catch {
		throw new ToolError(`Page ${pageId} was not found or is not shared with the integration`);
	}
	// Only pages inside 日程 may be edited through these tools.
	if (page.parent?.data_source_id !== NOTION_CONFIG.scheduleDataSourceId) throw new ToolError(`Page ${pageId} is not in the 日程 database`);
	return toItem(page);
}

// ==================== Dates ====================

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

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

function overlaps(item: ScheduleItem, from: number, to: number): boolean {
	if (!item.start) return false;
	const start = instant(item.start);
	// All-day items cover the whole of their last day.
	const end = (item.end ? instant(item.end) : start) + (item.all_day ? DAY_MS : 0);
	return start < to && (end > from || (end === start && start >= from));
}

async function queryWindow(notion: Client, from: number, to: number, limit = 100): Promise<ScheduleItem[]> {
	// Widen the Notion filter (multi-day items start earlier than the window), then filter exactly.
	const response = await notion.dataSources.query({
		data_source_id: NOTION_CONFIG.scheduleDataSourceId,
		page_size: limit,
		filter: {
			and: [
				{ property: SCHEDULE_PROPS.date, date: { on_or_after: new Date(from - DAY_MS * 31).toISOString() } },
				{ property: SCHEDULE_PROPS.date, date: { on_or_before: new Date(to + DAY_MS).toISOString() } },
			],
		} as any,
		sorts: [{ property: SCHEDULE_PROPS.date, direction: 'ascending' }],
	});
	return (response.results as unknown as Page[]).map(toItem).filter((item) => overlaps(item, from, to));
}

// ==================== Tools ====================

export type ListTasksInput = { statuses?: string[]; include_done?: boolean; due_on_or_before?: string; limit?: number };

/** Tasks with or without a date; open ones (not Done) by default. */
export async function listTasks(notion: Client, input: ListTasksInput): Promise<ScheduleItem[]> {
	const and: Props[] = [];
	if (input.statuses?.length) {
		and.push({ or: input.statuses.map((name) => ({ property: SCHEDULE_PROPS.status, status: { equals: name } })) });
	} else if (!input.include_done) {
		and.push({ property: SCHEDULE_PROPS.status, status: { does_not_equal: DONE } });
	}
	if (input.due_on_or_before) and.push({ property: SCHEDULE_PROPS.date, date: { on_or_before: input.due_on_or_before } });
	const response = await notion.dataSources.query({
		data_source_id: NOTION_CONFIG.scheduleDataSourceId,
		page_size: input.limit ?? 25,
		...(and.length ? { filter: { and } as any } : {}),
		sorts: [
			{ property: SCHEDULE_PROPS.date, direction: 'ascending' },
			{ timestamp: 'last_edited_time', direction: 'descending' },
		],
	});
	return (response.results as unknown as Page[]).map(toItem);
}

export async function listCalendar(notion: Client, input: { start: string; end: string; limit?: number }): Promise<ScheduleItem[]> {
	const from = instant(input.start);
	const to = instant(input.end) + (DATE_ONLY.test(input.end) ? DAY_MS : 0);
	if (!(to > from)) throw new ToolError('end must be after start');
	return (await queryWindow(notion, from, to)).slice(0, input.limit ?? 50);
}

export type SaveTaskInput = {
	page_id?: string;
	title?: string;
	start?: string | null;
	end?: string | null;
	status?: string;
	priority?: string;
};

export async function saveTask(notion: Client, input: SaveTaskInput): Promise<ScheduleItem> {
	const current = input.page_id ? await loadItem(notion, input.page_id) : undefined;
	if (!current && !input.title?.trim()) throw new ToolError('title is required when creating a task');
	const changesDate = input.start !== undefined || input.end !== undefined;
	if (current?.locked && (changesDate || input.title !== undefined)) {
		throw new ToolError(`"${current.title}" is locked (锁定): AI may only change its status or priority`);
	}

	let start = input.start === undefined ? current?.start ?? null : input.start;
	let end = input.end === undefined ? current?.end ?? null : input.end;
	if (start === null) end = null;
	if (end !== null && start === null) throw new ToolError('end needs a start');
	// Moving an item without a new end keeps its duration.
	if (input.start && input.end === undefined && current?.start && current.end) {
		const shifted = instant(input.start) + (instant(current.end) - instant(current.start));
		end = DATE_ONLY.test(input.start) ? new Date(shifted + DAY_MS / 2).toISOString().slice(0, 10) : toOffsetTime(shifted);
	}
	if (start && end) {
		if (DATE_ONLY.test(start) !== DATE_ONLY.test(end)) throw new ToolError('start and end must both be dates or both be date-times');
		if (!(instant(end) > instant(start)) && !(DATE_ONLY.test(start) && end === start)) throw new ToolError('end must be after start');
	}

	// Never create a time conflict with another timed, unfinished item. All-day items do not block time.
	if (changesDate && start && !DATE_ONLY.test(start)) {
		const from = instant(start);
		const to = end ? instant(end) : from;
		const conflicts = (await queryWindow(notion, from, Math.max(to, from + 1)))
			.filter((item) => item.id !== current?.id && !item.all_day && item.status !== DONE);
		if (conflicts.length) {
			throw new ToolError(`Time conflict with: ${conflicts.map((item) => `"${item.title}" (${item.start} – ${item.end ?? item.start})`).join('; ')}`);
		}
	}

	const properties: Props = {};
	if (input.title !== undefined) properties[SCHEDULE_PROPS.title] = { title: [{ type: 'text', text: { content: input.title.slice(0, 2000) } }] };
	if (changesDate) properties[SCHEDULE_PROPS.date] = { date: start === null ? null : { start, end } };
	if (input.status !== undefined) properties[SCHEDULE_PROPS.status] = { status: { name: input.status } };
	if (input.priority !== undefined) properties[SCHEDULE_PROPS.priority] = { select: { name: input.priority } };

	if (!current) {
		const created = await notion.pages.create({
			parent: { type: 'data_source_id', data_source_id: NOTION_CONFIG.scheduleDataSourceId },
			properties: { [SCHEDULE_PROPS.status]: { status: { name: 'Not started' } }, ...properties },
		});
		return toItem(created as unknown as Page);
	}
	if (Object.keys(properties).length === 0) throw new ToolError('No fields to update');
	return toItem((await notion.pages.update({ page_id: current.id, properties })) as unknown as Page);
}
