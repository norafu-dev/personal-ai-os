import { describe, expect, it } from 'vitest';
import { NOTION_CONFIG } from '../src/config/notion';
import { createNotionClient } from '../src/notion/client';
import { ToolError, listCalendar, listTasks, saveCalendarEvent, saveTask } from '../src/notion/tools';

const TASKS = NOTION_CONFIG.tasksDataSourceId;
const CALENDAR = NOTION_CONFIG.calendarDataSourceId;

type FakePage = { object: 'page'; id: string; url: string; parent: Record<string, string>; properties: Record<string, any>; last_edited_time: string };

// Notion echoes written text back with plain_text filled in.
function normalize(properties: Record<string, any>) {
	for (const value of Object.values(properties)) {
		for (const part of value?.title ?? value?.rich_text ?? []) part.plain_text ??= part.text?.content;
	}
	return properties;
}

// In-memory stand-in for the Notion REST API, reached through the real SDK client.
function fakeNotion() {
	const pages = new Map<string, FakePage>();
	const calls: { method: string; path: string; body?: any }[] = [];
	let next = 1;
	const add = (dataSourceId: string, properties: Record<string, any>) => {
		const id = `page-${next++}`;
		pages.set(id, { object: 'page', id, url: `https://notion.so/${id}`, parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties, last_edited_time: '2026-10-21T00:00:00.000Z' });
		return id;
	};
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path: url.pathname, body });
		const query = url.pathname.match(/^\/v1\/data_sources\/([^/]+)\/query$/);
		if (query) {
			const results = [...pages.values()].filter((page) => page.parent.data_source_id === query[1]);
			return Response.json({ object: 'list', results, has_more: false, next_cursor: null });
		}
		const pagePath = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
		if (pagePath) {
			const page = pages.get(pagePath[1]);
			if (!page) return Response.json({ object: 'error', status: 404, code: 'object_not_found', message: 'not found' }, { status: 404 });
			if (method === 'PATCH') Object.assign(page.properties, normalize(body.properties));
			return Response.json(page);
		}
		if (url.pathname === '/v1/pages' && method === 'POST') {
			return Response.json(pages.get(add(body.parent.data_source_id, normalize(body.properties))));
		}
		return Response.json({ object: 'error', status: 400, code: 'validation_error', message: 'unexpected' }, { status: 400 });
	};
	return { notion: createNotionClient('test', fetch as typeof globalThis.fetch), pages, calls, add };
}

const title = (value: string) => ({ title: [{ plain_text: value, text: { content: value } }] });
const event = (name: string, start: string, end: string | null = null, locked = false) => ({
	Name: title(name), Date: { date: { start, end } }, 锁定: { checkbox: locked },
});
const task = (name: string, status: string, needsConfirmation = false) => ({
	事项: title(name), 状态: { status: { name: status } }, 需要人工确认: { checkbox: needsConfirmation },
});

describe('task tools', () => {
	it('lists open tasks by default with a closed-status filter', async () => {
		const { notion, add, calls } = fakeNotion();
		add(TASKS, task('Write tools', '处理中'));
		const tasks = await listTasks(notion, {});
		expect(tasks).toEqual([expect.objectContaining({ title: 'Write tools', status: '处理中', needs_confirmation: false })]);
		expect(calls[0].path).toBe(`/v1/data_sources/${TASKS}/query`);
		expect(calls[0].body.filter.and).toEqual([
			{ property: '状态', status: { does_not_equal: '已完成' } },
			{ property: '状态', status: { does_not_equal: '已归档' } },
		]);
	});

	it('creates tasks as ChatGPT in the inbox', async () => {
		const { notion, calls } = fakeNotion();
		const created = await saveTask(notion, { title: 'Plan week', priority: '高' });
		expect(created).toMatchObject({ title: 'Plan week' });
		const props = calls.at(-1)!.body.properties;
		expect(calls.at(-1)!.body.parent).toEqual({ type: 'data_source_id', data_source_id: TASKS });
		expect(props.发起方).toEqual({ select: { name: 'ChatGPT' } });
		expect(props.状态).toEqual({ status: { name: '收件箱' } });
		expect(props.优先级).toEqual({ select: { name: '高' } });
		await expect(saveTask(notion, {})).rejects.toBeInstanceOf(ToolError);
	});

	it('updates only given fields and refuses to complete tasks needing confirmation', async () => {
		const { notion, add, calls } = fakeNotion();
		const id = add(TASKS, task('Decide', '处理中', true));
		await expect(saveTask(notion, { page_id: id, status: '已完成' })).rejects.toThrow(/待评审/);
		await saveTask(notion, { page_id: id, status: '待评审', due: null });
		expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { properties: { 状态: { status: { name: '待评审' } }, 截止时间: { date: null } } } });
		expect(Object.keys(calls.at(-1)!.body.properties)).toEqual(['状态', '截止时间']);
	});

	it('refuses pages outside the task database', async () => {
		const { notion, add } = fakeNotion();
		const id = add(CALENDAR, event('Not a task', '2026-10-22'));
		await expect(saveTask(notion, { page_id: id, status: '已完成' })).rejects.toThrow(/expected Notion database/);
		await expect(saveTask(notion, { page_id: 'missing', status: '已完成' })).rejects.toThrow(/not found/);
	});
});

describe('calendar tools', () => {
	it('lists only events overlapping the window', async () => {
		const { notion, add } = fakeNotion();
		add(CALENDAR, event('Morning', '2026-10-22T09:00:00+09:00', '2026-10-22T10:00:00+09:00'));
		add(CALENDAR, event('All day', '2026-10-22'));
		add(CALENDAR, event('Trip', '2026-10-20', '2026-10-23'));
		add(CALENDAR, event('Next day', '2026-10-23T09:00:00+09:00', '2026-10-23T10:00:00+09:00'));
		const events = await listCalendar(notion, { start: '2026-10-22', end: '2026-10-22' });
		expect(events.map((value) => value.title).sort()).toEqual(['All day', 'Morning', 'Trip']);
		expect(events.find((value) => value.title === 'All day')).toMatchObject({ all_day: true });
	});

	it('creates events and refuses overlaps with timed events', async () => {
		const { notion, add, calls } = fakeNotion();
		add(CALENDAR, event('Meeting', '2026-10-22T09:00:00+09:00', '2026-10-22T10:00:00+09:00'));
		add(CALENDAR, event('All day', '2026-10-22'));
		await expect(saveCalendarEvent(notion, { title: 'Focus', start: '2026-10-22T09:30:00+09:00', end: '2026-10-22T11:00:00+09:00' }))
			.rejects.toThrow(/conflict.*Meeting/);
		const { event: created } = await saveCalendarEvent(notion, { title: 'Focus', start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T11:00:00+09:00' });
		expect(created).toMatchObject({ title: 'Focus', start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T11:00:00+09:00' });
		expect(calls.at(-1)!.body.parent).toEqual({ type: 'data_source_id', data_source_id: CALENDAR });
	});

	it('moves events keeping duration, but never locked ones', async () => {
		const { notion, add, pages } = fakeNotion();
		const id = add(CALENDAR, event('Gym', '2026-10-22T18:00:00+09:00', '2026-10-22T19:30:00+09:00'));
		const locked = add(CALENDAR, event('Doctor', '2026-10-24T10:00:00+09:00', '2026-10-24T11:00:00+09:00', true));
		await saveCalendarEvent(notion, { page_id: id, start: '2026-10-23T07:00:00+09:00' });
		expect(pages.get(id)!.properties.Date).toEqual({ date: { start: '2026-10-23T07:00:00+09:00', end: '2026-10-23T08:30:00+09:00' } });
		await expect(saveCalendarEvent(notion, { page_id: locked, start: '2026-10-25T10:00:00+09:00' })).rejects.toThrow(/locked/);
		// Moving into its own old slot is not a conflict with itself.
		await saveCalendarEvent(notion, { page_id: id, start: '2026-10-23T07:30:00+09:00' });
	});

	it('validates ranges', async () => {
		const { notion } = fakeNotion();
		await expect(saveCalendarEvent(notion, { title: 'Bad', start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T09:00:00+09:00' })).rejects.toThrow(/after start/);
		await expect(saveCalendarEvent(notion, { title: 'Mixed', start: '2026-10-22', end: '2026-10-22T09:00:00+09:00' })).rejects.toThrow(/both/);
		await expect(listCalendar(notion, { start: '2026-10-23', end: '2026-10-22' })).rejects.toThrow(/after start/);
	});
});
