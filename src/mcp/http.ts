import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from './server';
import { listMcpEvents, McpEventError, subscribeMcpEvent, unsubscribeMcpEvent, type McpEventsEnv } from './events';

export type McpHttpEnv = McpEventsEnv & { MCP_AUTH_TOKEN: string };

const mcpHandler = createMcpHandler(createMcpServer);

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
	if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return rpcError(null, -32700, 'Parse error');
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return rpcError(null, -32600, 'Invalid Request');
	const message = body as Record<string, unknown>;
	const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
	if (message.jsonrpc !== '2.0' || id === null || typeof message.method !== 'string') return rpcError(id, -32600, 'Invalid Request');
	const owner = 'nora';
	try {
		switch (message.method) {
			case 'server/discover':
				return rpcResult(id, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
			case 'events/list':
				return rpcResult(id, listMcpEvents());
			case 'events/subscribe':
				return rpcResult(id, await subscribeMcpEvent(env, owner, message.params));
			case 'events/unsubscribe':
				return rpcResult(id, await unsubscribeMcpEvent(env, owner, message.params));
			default:
				return mcpHandler.fetch(request, {
					parsedBody: body,
					authInfo: { token: bearer, clientId: 'personal-ai-os', scopes: ['mcp:tools', 'mcp:events'] },
				});
		}
	} catch (error) {
		if (error instanceof McpEventError) return rpcError(id, error.code, error.message, error.data);
		console.error('MCP request failed:', error);
		return rpcError(id, -32603, 'Internal error');
	}
}
