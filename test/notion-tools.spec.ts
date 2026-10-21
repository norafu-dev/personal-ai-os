import { describe, expect, it } from 'vitest';
import { NOTION_CONFIG } from '../src/config/notion';
import { createNotionClient } from '../src/notion/client';
import { ToolError, listCalendar, listTasks, saveTask } from '../src/notion/tools';

const SCHEDULE = NOTION_CONFIG.scheduleDataSourceId;
const OTHER = '95af6fad-798f-4d0a-b370-356646a5745d';

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
const item = (name: string, start: string | null, end: string | null = null, { locked = false, status = 'Not started' } = {}) => ({
	Name: title(name), Date: { date: start ? { start, end } : null }, Status: { status: { name: status } }, 锁定: { checkbox: locked },
});

describe('list tools', () => {
	it('lists unfinished tasks by default, with or without a date', async () => {
		const { notion, add, calls } = fakeNotion();
		add(SCHEDULE, item('Backlog', null));
		const tasks = await listTasks(notion, {});
		expect(tasks).toEqual([expect.objectContaining({ title: 'Backlog', status: 'Not started', start: null })]);
		expect(calls[0].path).toBe(`/v1/data_sources/${SCHEDULE}/query`);
		expect(calls[0].body.filter.and).toEqual([{ property: 'Status', status: { does_not_equal: 'Done' } }]);
		await listTasks(notion, { include_done: true });
		expect(calls[1].body.filter).toBeUndefined();
	});

	it('lists only items overlapping the window', async () => {
		const { notion, add } = fakeNotion();
		add(SCHEDULE, item('Morning', '2026-10-22T09:00:00+09:00', '2026-10-22T10:00:00+09:00'));
		add(SCHEDULE, item('All day', '2026-10-22'));
		add(SCHEDULE, item('Trip', '2026-10-20', '2026-10-23'));
		add(SCHEDULE, item('Next day', '2026-10-23T09:00:00+09:00', '2026-10-23T10:00:00+09:00'));
		const items = await listCalendar(notion, { start: '2026-10-22', end: '2026-10-22' });
		expect(items.map((value) => value.title).sort()).toEqual(['All day', 'Morning', 'Trip']);
		expect(items.find((value) => value.title === 'All day')).toMatchObject({ all_day: true });
		await expect(listCalendar(notion, { start: '2026-10-23', end: '2026-10-22' })).rejects.toThrow(/after start/);
	});
});

describe('save_task', () => {
	it('creates tasks as Not started in 日程', async () => {
		const { notion, calls } = fakeNotion();
		const created = await saveTask(notion, { title: 'Plan week', priority: '高' });
		expect(created).toMatchObject({ title: 'Plan week', start: null });
		expect(calls.at(-1)!.body.parent).toEqual({ type: 'data_source_id', data_source_id: SCHEDULE });
		expect(calls.at(-1)!.body.properties.Status).toEqual({ status: { name: 'Not started' } });
		expect(calls.at(-1)!.body.properties.Priority).toEqual({ select: { name: '高' } });
		await expect(saveTask(notion, {})).rejects.toBeInstanceOf(ToolError);
	});

	it('updates only given fields and refuses pages outside 日程', async () => {
		const { notion, add, calls } = fakeNotion();
		const id = add(SCHEDULE, item('Write', null));
		await saveTask(notion, { page_id: id, status: 'Done' });
		expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { properties: { Status: { status: { name: 'Done' } } } } });
		expect(Object.keys(calls.at(-1)!.body.properties)).toEqual(['Status']);
		const other = add(OTHER, item('Queue item', null));
		await expect(saveTask(notion, { page_id: other, status: 'Done' })).rejects.toThrow(/not in the 日程/);
		await expect(saveTask(notion, { page_id: 'missing', status: 'Done' })).rejects.toThrow(/not found/);
	});

	it('refuses overlaps with unfinished timed items only', async () => {
		const { notion, add } = fakeNotion();
		add(SCHEDULE, item('Meeting', '2026-10-22T09:00:00+09:00', '2026-10-22T10:00:00+09:00'));
		add(SCHEDULE, item('Finished', '2026-10-22T10:00:00+09:00', '2026-10-22T11:00:00+09:00', { status: 'Done' }));
		add(SCHEDULE, item('All day', '2026-10-22'));
		await expect(saveTask(notion, { title: 'Focus', start: '2026-10-22T09:30:00+09:00', end: '2026-10-22T11:00:00+09:00' }))
			.rejects.toThrow(/conflict.*Meeting/);
		const created = await saveTask(notion, { title: 'Focus', start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T11:00:00+09:00' });
		expect(created).toMatchObject({ start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T11:00:00+09:00' });
	});

	it('moves items keeping duration; locked items only change status or priority', async () => {
		const { notion, add, pages } = fakeNotion();
		const id = add(SCHEDULE, item('Gym', '2026-10-22T18:00:00+09:00', '2026-10-22T19:30:00+09:00'));
		const locked = add(SCHEDULE, item('Doctor', '2026-10-24T10:00:00+09:00', '2026-10-24T11:00:00+09:00', { locked: true }));
		await saveTask(notion, { page_id: id, start: '2026-10-23T07:00:00+09:00' });
		expect(pages.get(id)!.properties.Date).toEqual({ date: { start: '2026-10-23T07:00:00+09:00', end: '2026-10-23T08:30:00+09:00' } });
		// Moving into its own old slot is not a conflict with itself.
		await saveTask(notion, { page_id: id, start: '2026-10-23T07:30:00+09:00' });
		await expect(saveTask(notion, { page_id: locked, start: '2026-10-25T10:00:00+09:00' })).rejects.toThrow(/locked/);
		await expect(saveTask(notion, { page_id: locked, title: 'Renamed' })).rejects.toThrow(/locked/);
		await saveTask(notion, { page_id: locked, status: 'Done' });
		expect(pages.get(locked)!.properties.Status).toEqual({ status: { name: 'Done' } });
	});

	it('clears dates and validates ranges', async () => {
		const { notion, add, pages } = fakeNotion();
		const id = add(SCHEDULE, item('Someday', '2026-10-22'));
		await saveTask(notion, { page_id: id, start: null });
		expect(pages.get(id)!.properties.Date).toEqual({ date: null });
		await expect(saveTask(notion, { title: 'Bad', start: '2026-10-22T10:00:00+09:00', end: '2026-10-22T09:00:00+09:00' })).rejects.toThrow(/after start/);
		await expect(saveTask(notion, { title: 'Mixed', start: '2026-10-22', end: '2026-10-22T09:00:00+09:00' })).rejects.toThrow(/both/);
	});
});
