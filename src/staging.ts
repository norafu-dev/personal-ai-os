import worker from './index';
import { createStagingOAuthProvider, type StagingOAuthEnv } from './auth/staging-oauth';

export default {
	async fetch(request: Request, env: StagingOAuthEnv, ctx: ExecutionContext): Promise<Response> {
		// Canonical origin is configuration, never inferred from a Host header.
		try {
			const url = new URL(request.url);
			if (url.pathname === '/mcp' || url.pathname === '/authorize' || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
				if (url.origin !== env.OAUTH_ISSUER) return new Response('Use the configured OAuth origin', { status: 400 });
			}
			return await createStagingOAuthProvider(env, worker.fetch).fetch(request, env, ctx);
		} catch {
			// Do not log requests, codes, tokens or provider error details.
			return new Response('Staging OAuth unavailable', { status: 503 });
		}
	},
	scheduled: worker.scheduled,
};
