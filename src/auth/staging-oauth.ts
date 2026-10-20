import OAuthProvider, {
	AuthorizationError,
	OAuthError,
	authorizationErrorRedirect,
	insufficientScope,
	type OAuthHelpers,
	type ConsentDescription,
	type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { handleAuthenticatedMcpHttp } from '../mcp/http';
import type worker from '../index';
import type { Bindings } from '../index';

export type StagingOAuthEnv = Bindings & {
	ENVIRONMENT: 'staging';
	OAUTH_KV: KVNamespace;
	OAUTH_ISSUER: string;
	OAUTH_REDIRECT_URIS: string;
	OAUTH_GITHUB_CLIENT_ID: string;
	OAUTH_GITHUB_CLIENT_SECRET: string;
	OAUTH_ALLOWED_GITHUB_ID: string;
	OAUTH_PROVIDER?: OAuthHelpers;
};
type Identity = { owner: 'nora'; githubId: string };
export const MCP_SCOPES = ['mcp:tools', 'mcp:events'];
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function stagingOAuthConfig(env: StagingOAuthEnv) {
	const issuer = new URL(env.OAUTH_ISSUER);
	if (env.ENVIRONMENT !== 'staging' || issuer.protocol !== 'https:' || issuer.origin !== env.OAUTH_ISSUER ||
		!/^\d+$/.test(env.OAUTH_ALLOWED_GITHUB_ID) || !env.OAUTH_GITHUB_CLIENT_ID || !env.OAUTH_GITHUB_CLIENT_SECRET || !env.OAUTH_KV) {
		throw new Error('Staging OAuth configuration is incomplete');
	}
	const parsed: unknown = JSON.parse(env.OAUTH_REDIRECT_URIS);
	if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((value): value is string => {
		if (typeof value !== 'string') return false;
		const url = new URL(value);
		return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
	})) throw new Error('Exact HTTPS OAuth redirect URIs are required');
	return { issuer: issuer.origin, resource: `${issuer.origin}/mcp`, redirects: parsed as string[] };
}

// Compatibility for the observed ChatGPT origin-only resource indicator. This is
// one exact alias for our single MCP resource, NOT an origin-wide token audience.
// Apply it at both authorization and token exchange; all grants remain /mcp-bound.
export async function canonicalizeStagingOAuthResource(request: Request, issuer: string): Promise<Request> {
	const url = new URL(request.url);
	if (url.origin !== issuer) return request;
	const replaceAlias = (params: URLSearchParams) => {
		if (params.getAll('resource').length !== 1 || params.get('resource') !== issuer) return false;
		params.set('resource', `${issuer}/mcp`);
		return true;
	};
	if (url.pathname === '/authorize' && request.method === 'GET') {
		if (replaceAlias(url.searchParams)) return new Request(url, request);
	} else if (url.pathname === '/oauth/token' && request.method === 'POST' &&
		request.headers.get('content-type')?.split(';')[0].trim() === 'application/x-www-form-urlencoded') {
		const params = new URLSearchParams(new TextDecoder().decode(await request.clone().arrayBuffer()));
		if (replaceAlias(params)) {
			const headers = new Headers(request.headers);
			headers.delete('content-length');
			return new Request(request, { headers, body: params });
		}
	}
	return request;
}

function consentPage(details: ConsentDescription, handle: string): string {
	return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Personal AI OS Staging 授权</title>
<h1>允许 ${escapeHtml(details.clientName)} 连接 Staging？</h1>
<p>客户端名称由注册方提供。回调地址：${escapeHtml(details.redirectUri)}</p>
<p>权限：${details.scope.map(escapeHtml).join(', ')}。仅 Nora 的 GitHub 账户可授权。</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">通过 GitHub 登录并允许</button>
<button name="decision" value="deny">拒绝</button></form></html>`;
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type GitHubStage = 'token_exchange' | 'user_identity';
const githubOAuthErrors = ['incorrect_client_credentials', 'redirect_uri_mismatch', 'bad_verification_code', 'unverified_user_email'] as const;
type GitHubFailureCode = typeof githubOAuthErrors[number] | 'oauth_error' | 'timeout' | 'network_error' | 'invalid_json' | 'http_error' | 'invalid_payload' | 'redirect_rejected';
class GitHubIdentityError extends Error {
	constructor(readonly stage: GitHubStage, readonly code: GitHubFailureCode, readonly httpStatus?: number) {
		super('GitHub authentication failed');
	}
}

async function githubJson(stage: GitHubStage, url: string, init: RequestInit) {
	let response: Response;
	try { response = await fetch(url, init); }
	catch (error) {
		throw new GitHubIdentityError(stage, error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error');
	}
	// Workers rejects redirect:error before sending. Manual + explicit rejection
	// preserves fail-closed behavior without forwarding credentials to a redirect.
	if (response.status >= 300 && response.status < 400) throw new GitHubIdentityError(stage, 'redirect_rejected', response.status);
	let payload: unknown;
	try { payload = await response.json(); }
	catch { throw new GitHubIdentityError(stage, response.ok ? 'invalid_json' : 'http_error', response.status); }
	if (stage === 'token_exchange' && payload && typeof payload === 'object' && 'error' in payload) {
		const code = githubOAuthErrors.find(value => value === payload.error) ?? 'oauth_error';
		throw new GitHubIdentityError(stage, code, response.status);
	}
	if (!response.ok) throw new GitHubIdentityError(stage, 'http_error', response.status);
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GitHubIdentityError(stage, 'invalid_payload', response.status);
	return { payload: payload as Record<string, unknown>, status: response.status };
}

// GitHub is used only to establish identity. No repository scopes or GitHub token storage.
async function githubIdentity(env: StagingOAuthEnv, code: string, verifier: string): Promise<string> {
	const tokenResponse = await githubJson('token_exchange', 'https://github.com/login/oauth/access_token', {
		method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
		headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env.OAUTH_GITHUB_CLIENT_ID, client_secret: env.OAUTH_GITHUB_CLIENT_SECRET,
			code, code_verifier: verifier, redirect_uri: `${env.OAUTH_ISSUER}/oauth/github/callback`,
		}),
	});
	const token = tokenResponse.payload;
	if (typeof token.access_token !== 'string' || !token.access_token || token.token_type !== 'bearer') throw new GitHubIdentityError('token_exchange', 'invalid_payload', tokenResponse.status);
	const response = await githubJson('user_identity', 'https://api.github.com/user', {
		redirect: 'manual', signal: AbortSignal.timeout(10_000),
		headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'User-Agent': 'personal-ai-os-staging' },
	});
	const user = response.payload;
	if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) throw new GitHubIdentityError('user_identity', 'invalid_payload', response.status);
	return String(user.id);
}

export function createStagingOAuthProvider(env: StagingOAuthEnv, fallback: typeof worker.fetch) {
	const config = stagingOAuthConfig(env);
	return new OAuthProvider<StagingOAuthEnv>({
		apiRoute: '/mcp',
		authorizeEndpoint: `${config.issuer}/authorize`,
		tokenEndpoint: `${config.issuer}/oauth/token`,
		clientRegistrationEndpoint: `${config.issuer}/oauth/register`,
		resourceMetadata: { resource: config.resource, authorization_servers: [config.issuer] },
		requiredScopes: MCP_SCOPES,
		scopesSupported: [...MCP_SCOPES, 'offline_access'],
		accessTokenTTL: 900,
		refreshTokenTTL: 7 * 24 * 60 * 60,
		clientIdMetadataDocumentEnabled: false,
		clientRegistrationCallback: ({ clientMetadata }) => {
			const redirects = clientMetadata.redirect_uris;
			if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every((uri) => config.redirects.includes(uri))) {
				return { code: 'invalid_redirect_uri', description: 'Redirect URI is not allowed' };
			}
			// All clients, including confidential ones, must use S256 PKCE (checked below).
		},
		tokenExchangeCallback: ({ props }) => {
			const identity = props as Partial<Identity> | undefined;
			if (identity?.owner !== 'nora' || identity.githubId !== env.OAUTH_ALLOWED_GITHUB_ID) {
				throw new OAuthError('invalid_grant', { description: 'Account no longer authorized' });
			}
		},
		onError: () => {}, // Provider defaults include diagnostic logging; keep auth details out of logs.
		apiHandler: {
			async fetch(request, providerEnv, ctx) {
				if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
				const identity = ctx.props as Partial<Identity> | undefined;
				const auth = (ctx as OAuthResourceContext<Identity>).auth;
				if (identity?.owner !== 'nora' || identity.githubId !== providerEnv.OAUTH_ALLOWED_GITHUB_ID) return new Response('Forbidden', { status: 403 });
				if (!MCP_SCOPES.every((scope) => auth.scope.includes(scope))) return insufficientScope(auth, MCP_SCOPES);
				return handleAuthenticatedMcpHttp(request, providerEnv, { owner: identity.owner, token: auth.token, scopes: auth.scope });
			},
		},
		defaultHandler: {
			async fetch(request, providerEnv, ctx) {
				const url = new URL(request.url);
				const oauth = providerEnv.OAUTH_PROVIDER!;
				let stage = 'authorize.parse';
				try {
					if (url.pathname === '/authorize' && request.method === 'GET') {
						const parsed = await oauth.parseAuthRequest(request);
						if (!config.redirects.includes(parsed.redirectUri) || url.searchParams.get('code_challenge_method') !== 'S256' ||
							!MCP_SCOPES.every((scope) => parsed.scope.includes(scope)) || parsed.scope.some((scope) => ![...MCP_SCOPES, 'offline_access'].includes(scope))) {
							return new Response('Invalid redirect, PKCE or scopes', { status: 400 });
						}
						stage = 'authorize.describe_consent';
						const details = await oauth.describeConsent(parsed);
						stage = 'authorize.begin_consent';
						const consent = await oauth.beginConsent(parsed);
						consent.headers.set('Content-Type', 'text/html; charset=utf-8');
						// no-referrer makes a browser's form POST Origin null. Keep the
						// same-origin consent POST verifiable without leaking to GitHub.
						consent.headers.set('Referrer-Policy', 'same-origin');
						return new Response(consentPage(details, consent.handle), { headers: consent.headers });
					}
					if (url.pathname === '/authorize' && request.method === 'POST') {
						stage = 'authorize.submit_consent';
						if (request.headers.get('origin') !== config.issuer) return new Response('Invalid origin', { status: 403 });
						const form = await request.formData();
						const handle = String(form.get('handle') ?? '');
						if (form.get('decision') !== 'approve') {
							const denied = await oauth.denyConsent(request, handle);
							return new Response(null, { status: 302, headers: denied.headers });
						}
						const approved = await oauth.approveConsent(request, handle);
						const verifier = crypto.randomUUID() + crypto.randomUUID();
						const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
						const github = new URL('https://github.com/login/oauth/authorize');
						github.search = new URLSearchParams({ client_id: env.OAUTH_GITHUB_CLIENT_ID,
							redirect_uri: `${config.issuer}/oauth/github/callback`, state: upstream.state,
							code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', scope: '', allow_signup: 'false' }).toString();
						upstream.headers.set('Location', github.href);
						return new Response(null, { status: 302, headers: upstream.headers });
					}
					if (url.pathname === '/oauth/github/callback' && request.method === 'GET') {
						stage = 'authorize.github_callback';
						const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
						const code = url.searchParams.get('code');
						if (url.searchParams.has('error') || !code) {
							upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
							return new Response(null, { status: 302, headers: upstream.headers });
						}
						let githubId: string;
						try { githubId = await githubIdentity(env, code, upstream.data.verifier); }
						catch (error) {
							const diagnostic = error instanceof GitHubIdentityError
								? { stage: error.stage, code: error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
								: { stage: 'github_callback', code: 'internal_error' };
							// Fixed enums + numeric status only. Never log errors, bodies,
							// URLs, credentials, codes, PKCE values or account information.
							console.warn('staging_github_auth_failed', diagnostic);
							upstream.headers.set('X-Staging-Auth-Stage', diagnostic.stage);
							upstream.headers.set('X-Staging-Auth-Code', diagnostic.code);
							if ('httpStatus' in diagnostic) upstream.headers.set('X-Staging-Auth-HTTP-Status', String(diagnostic.httpStatus));
							return new Response('GitHub authentication failed', { status: 502, headers: upstream.headers });
						}
						if (githubId !== env.OAUTH_ALLOWED_GITHUB_ID) return new Response('Account not authorized', { status: 403, headers: upstream.headers });
						const completed = await oauth.completeAuthorization({ request: upstream.request, userId: 'nora',
							metadata: {}, scope: upstream.request.scope, props: { owner: 'nora', githubId } satisfies Identity });
						upstream.headers.set('Location', completed.redirectTo);
						return new Response(null, { status: 302, headers: upstream.headers });
					}
				} catch (error) {
					if (error instanceof AuthorizationError) {
						// Never log the error object/description: it can contain client input.
						const code = ['invalid_request', 'invalid_target', 'invalid_scope', 'unauthorized_client', 'unsupported_response_type', 'access_denied'].includes(error.code)
							? error.code : 'authorization_error';
						console.warn('staging_oauth_rejected', { stage, code });
						return new Response('Invalid or expired authorization request', { status: 400, headers: { 'Cache-Control': 'no-store' } });
					}
					throw error;
				}
				// Never fall back to static Bearer authentication for /mcp or OAuth paths.
				if (url.pathname.startsWith('/mcp') || url.pathname.startsWith('/oauth') || url.pathname.startsWith('/.well-known') || url.pathname === '/authorize') {
					return new Response('Not found', { status: 404 });
				}
				return fallback(request, providerEnv, ctx);
			},
		},
	});
}
