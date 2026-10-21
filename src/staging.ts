import worker from './index';
import { createStagingDiagnostics } from './mcp/diagnostics';
import { canonicalizeStagingOAuthResource, createStagingOAuthProvider, type StagingOAuthEnv } from './auth/staging-oauth';

export default {
	async fetch(request: Request, env: StagingOAuthEnv, ctx: ExecutionContext): Promise<Response> {
		const observer = new URL(request.url).pathname === '/mcp'
			? createStagingDiagnostics(env.ENVIRONMENT === 'staging' && env.MCP_EVENTS_DIAGNOSTICS === '1') : undefined;
		let status = 503;
		// Canonical origin is configuration, never inferred from a Host header.
		try {
			const url = new URL(request.url);
			if (url.pathname === '/mcp' || url.pathname === '/authorize' || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
				if (url.origin !== env.OAUTH_ISSUER) { status = 400; return new Response('Use the configured OAuth origin', { status }); }
			}
			const provider = createStagingOAuthProvider(env, worker.fetch, observer);
			observer?.enter('authentication');
			const response = await provider.fetch(await canonicalizeStagingOAuthResource(request, env.OAUTH_ISSUER), env, ctx);
			status = response.status;
			return response;
		} catch {
			observer?.failed('internal_error');
			// Do not log requests, codes, tokens or provider error details.
			return new Response('Staging OAuth unavailable', { status: 503 });
		} finally {
			observer?.finish(status);
		}
	},
	scheduled: worker.scheduled,
};
