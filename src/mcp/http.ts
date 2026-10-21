import type { McpDiagnostics } from './diagnostics';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createNotionClient } from '../notion/client';
import { createMcpServer } from './server';
import { listMcpEvents, McpEventError, subscribeMcpEvent, unsubscribeMcpEvent, type McpEventsEnv } from './events';

export type McpToolsEnv = McpEventsEnv & { NOTION_API_KEY: string };
export type McpHttpEnv = McpToolsEnv & { MCP_AUTH_TOKEN: string };

function equalToken(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let difference = a.length ^ b.length;
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	}
	return difference === 0;
}

function rpcResult(id: string | number, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

export async function handleMcpHttp(request: Request, env: McpHttpEnv): Promise<Response> {
	if (!env.MCP_AUTH_TOKEN) return new Response('MCP authentication is not configured', { status: 503 });
	const authorization = request.headers.get('authorization');
	const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
	if (!bearer || !equalToken(bearer, env.MCP_AUTH_TOKEN)) {
		return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
	}
	return handleAuthenticatedMcpHttp(request, env, { owner: 'nora', token: bearer, scopes: ['mcp:tools', 'mcp:events'] });
}

// Only authentication adapters call this function; it is not a separate HTTP route.
export async function handleAuthenticatedMcpHttp(
	request: Request,
	env: McpToolsEnv,
	principal: { owner: string; token: string; scopes: string[] },
	observer?: McpDiagnostics,
): Promise<Response> {
	if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
	const result = (id: string | number, value: unknown) => { observer?.rpc(); return rpcResult(id, value); };
	const failure = (id: string | number | null, code: number, message: string, data?: unknown) => { observer?.rpc(code); return rpcError(id, code, message, data); };
	observer?.enter('rpc_parse');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		observer?.failed('invalid_json');
		return failure(null, -32700, 'Parse error');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) { observer?.failed('invalid_request'); return failure(null, -32600, 'Invalid Request'); }
	const message = body as Record<string, unknown>;
	const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
	if (message.jsonrpc !== '2.0' || id === null || typeof message.method !== 'string') { observer?.failed('invalid_request'); return failure(id, -32600, 'Invalid Request'); }
	observer?.method(message.method);
	observer?.passed();
	observer?.enter('authenticated_dispatch');
	observer?.passed();
	const owner = principal.owner;
	try {
		switch (message.method) {
			case 'server/discover':
				return result(id, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
			case 'events/list':
				return result(id, listMcpEvents());
			case 'events/subscribe':
				return result(id, await subscribeMcpEvent(env, owner, message.params, fetch, observer));
			case 'events/unsubscribe':
				return result(id, await unsubscribeMcpEvent(env, owner, message.params, observer));
			default: {
				// Per request: the server factory needs this request's Notion credentials.
				const notion = createNotionClient(env.NOTION_API_KEY);
				return createMcpHandler(() => createMcpServer(notion)).fetch(request, {
					parsedBody: body,
					authInfo: { token: principal.token, clientId: 'personal-ai-os', scopes: principal.scopes },
				});
			}
		}
	} catch (error) {
		if (error instanceof McpEventError) return failure(id, error.code, error.message, error.data);
		if (!observer) console.error('MCP request failed:', error);
		return failure(id, -32603, 'Internal error');
	}
}
