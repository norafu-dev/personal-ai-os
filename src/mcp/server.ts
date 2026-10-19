import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export function createMcpServer() {
	const server = new McpServer({
		name: 'personal-ai-os',
		version: '0.1.0',
	});

	server.registerTool(
		'get_projects',
		{
			description: '获取 Notion 中的项目列表',
			inputSchema: z.object({
				status: z.string().optional(),
			}),
		},
		async ({ status }) => ({
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						message: 'MCP Tool 调用成功',
						status: status ?? null,
					}),
				},
			],
		}),
	);

	return server;
}
