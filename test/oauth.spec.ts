import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import staging from '../src/staging';
import { canonicalizeStagingOAuthResource, createStagingOAuthProvider, type StagingOAuthEnv } from '../src/auth/staging-oauth';
import worker from '../src/index';

const origin = 'https://personal-ai-os-staging.noradev.workers.dev';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const resource = `${origin}/mcp`;
const scopes = 'mcp:tools mcp:events offline_access';
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const testEnv: StagingOAuthEnv = { ...env, OAUTH_GITHUB_CLIENT_ID: 'test-client',
	OAUTH_GITHUB_CLIENT_SECRET: 'test-secret', OAUTH_ALLOWED_GITHUB_ID: '12345' };

async function call(path: string, init: RequestInit = {}, config = testEnv) {
	const ctx = createExecutionContext();
	const response = await staging.fetch(new Request(`${origin}${path}`, init), config, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function challenge() {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cookie(response: Response) {
	return response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
}

async function register(redirects = [redirectUri]) {
	return call('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client_name: '<script>evil</script>', redirect_uris: redirects,
			grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
}

async function consent(extra: Record<string, string> = {}) {
	const response = await register();
	expect(response.status).toBe(201);
	const client = await response.json() as { client_id: string };
	const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri,
		response_type: 'code', scope: scopes, resource, state: 'client-state',
		code_challenge: await challenge(), code_challenge_method: 'S256', ...extra });
	const page = await call(`/authorize?${params}`);
	return { page, client, params };
}

async function beginLogin(requestedResource = resource) {
	const { page, client } = await consent({ resource: requestedResource, ui_locales: 'zh-CN' });
	expect(page.status).toBe(200);
	const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1];
	const approved = await call('/authorize', { method: 'POST', headers: { origin, cookie: cookie(page) },
		body: new URLSearchParams({ handle, decision: 'approve' }) });
	expect(approved.status).toBe(302);
	const githubUrl = new URL(approved.headers.get('Location')!);
	expect(githubUrl.origin).toBe('https://github.com');
	expect(githubUrl.searchParams.get('code_challenge_method')).toBe('S256');
	return { approved, githubUrl, client };
}

async function login(githubId = 12345, requestedResource = resource) {
	const { approved, githubUrl, client } = await beginLogin(requestedResource);
	const fetchMock = vi.spyOn(globalThis, 'fetch')
		.mockResolvedValueOnce(Response.json({ access_token: 'github-test-token', token_type: 'bearer' }))
		.mockResolvedValueOnce(Response.json({ id: githubId }));
	const callback = await call(`/oauth/github/callback?code=github-code&state=${githubUrl.searchParams.get('state')}`,
		{ headers: { cookie: cookie(approved) } });
	expect(fetchMock).toHaveBeenCalledTimes(2);
	const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
	expect(body.get('code_verifier')).toBeTruthy();
	expect(body.get('redirect_uri')).toBe(`${origin}/oauth/github/callback`);
	fetchMock.mockRestore();
	return { callback, client };
}

async function exchange(clientId: string, code: string, options: Record<string, string> = {}) {
	return call('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
			code, code_verifier: verifier, redirect_uri: redirectUri, resource, ...options }) });
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number };
async function obtainTokens() {
	const { callback, client } = await login();
	expect(callback.status).toBe(302);
	const location = new URL(callback.headers.get('Location')!);
	expect(location.origin + location.pathname).toBe(redirectUri);
	expect(location.searchParams.get('iss')).toBe(origin);
	expect(location.searchParams.get('state')).toBe('client-state');
	const code = location.searchParams.get('code')!;
	const response = await exchange(client.client_id, code);
	expect(response.status).toBe(200);
	return { tokens: await response.json() as Tokens, client, code };
}

function rpc(token: string, method = 'server/discover', params: object = {}) {
	return call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`,
		'content-type': 'application/json', accept: 'application/json, text/event-stream',
		'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params,
			_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
				'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
				'io.modelcontextprotocol/clientCapabilities': {} } } }) });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('staging OAuth with the real provider and local KV', () => {
	it('discovers the registered tool and event definitions with a resource-bound OAuth token', async () => {
		// Real local Provider/KV and PKCE/code exchange; only GitHub HTTP is mocked.
		// Keep credentials in memory and assert payloads, not just HTTP 200.
		const { tokens } = await obtainTokens();
		const tools = await rpc(tokens.access_token, 'tools/list');
		expect(tools.status).toBe(200);
		expect(await tools.json()).toMatchObject({
			jsonrpc: '2.0', id: 1,
			result: { tools: expect.arrayContaining([expect.objectContaining({
				name: 'get_projects', inputSchema: expect.objectContaining({ type: 'object' }),
			})]) },
		});
		const discovery = await rpc(tokens.access_token, 'server/discover');
		expect(discovery.status).toBe(200);
		expect(await discovery.json()).toMatchObject({ jsonrpc: '2.0', id: 1,
			result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } } });
		const events = await rpc(tokens.access_token, 'events/list');
		expect(events.status).toBe(200);
		expect(await events.json()).toMatchObject({ jsonrpc: '2.0', id: 1,
			result: { events: expect.arrayContaining([expect.objectContaining({ name: 'notion.page_properties_updated' })]) } });
	});

	it('lists tools for a legacy stateless MCP client using the same OAuth audience', async () => {
		const { tokens } = await obtainTokens();
		const response = await call('/mcp', { method: 'POST', headers: {
			authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json',
			accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
		}, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }) });
		expect(response.status).toBe(200);
		const text = await response.text();
		const payload = response.headers.get('content-type')?.startsWith('text/event-stream')
			? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
			: JSON.parse(text);
		expect(payload).toMatchObject({ jsonrpc: '2.0', id: 7,
			result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'get_projects' })]) } });
		expect(payload.error).toBeUndefined();
	});

	it('constructs runtime-supported GitHub requests without following redirects', async () => {
		const { approved, githubUrl } = await beginLogin();
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			// Use workerd's real Request constructor: a plain mocked response hides
			// its rejection of redirect:error, which caused the deployed 502.
			const request = new Request(input, init);
			expect(request.redirect).toBe('manual');
			return request.url === 'https://github.com/login/oauth/access_token'
				? Response.json({ access_token: 'github-test-token', token_type: 'bearer' })
				: Response.json({ id: 12345 });
		});
		const response = await call(`/oauth/github/callback?code=github-code&state=${githubUrl.searchParams.get('state')}`,
			{ headers: { cookie: cookie(approved) } });
		expect(response.status).toBe(302);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	const githubFailures = [
		{ stage: 'token_exchange', code: 'redirect_rejected', status: 307, reply: () => new Response(null, { status: 307, headers: { location: 'https://private-redirect.example' } }) },
		{ stage: 'user_identity', code: 'redirect_rejected', status: 302, reply: () => new Response(null, { status: 302, headers: { location: 'https://private-redirect.example' } }) },
		...['incorrect_client_credentials', 'redirect_uri_mismatch', 'bad_verification_code', 'unverified_user_email'].map(code => ({
			stage: 'token_exchange', code, status: 200,
			reply: () => Response.json({ error: code, error_description: 'private-upstream-description' }),
		})),
		{ stage: 'token_exchange', code: 'oauth_error', status: 200, reply: () => Response.json({ error: 'private-arbitrary-error' }) },
		{ stage: 'token_exchange', code: 'invalid_payload', status: 200, reply: () => Response.json({ access_token: 'private-token', token_type: 'unexpected' }) },
		{ stage: 'token_exchange', code: 'invalid_json', status: 200, reply: () => new Response('private-invalid-json') },
		{ stage: 'token_exchange', code: 'http_error', status: 503, reply: () => new Response('private-upstream-body', { status: 503 }) },
		{ stage: 'token_exchange', code: 'timeout', status: undefined, reply: () => new DOMException('private-timeout-url', 'TimeoutError') },
		{ stage: 'token_exchange', code: 'network_error', status: undefined, reply: () => new Error('private-network-url') },
		{ stage: 'user_identity', code: 'http_error', status: 401, reply: () => Response.json({ message: 'private-github-message' }, { status: 401 }) },
		{ stage: 'user_identity', code: 'http_error', status: 403, reply: () => Response.json({ message: 'private-github-message' }, { status: 403 }) },
		{ stage: 'user_identity', code: 'invalid_json', status: 200, reply: () => new Response('private-invalid-json') },
		{ stage: 'user_identity', code: 'invalid_payload', status: 200, reply: () => Response.json(null) },
		{ stage: 'user_identity', code: 'invalid_payload', status: 200, reply: () => Response.json({ id: 'private-user-id' }) },
		{ stage: 'user_identity', code: 'timeout', status: undefined, reply: () => new DOMException('private-timeout-url', 'AbortError') },
		{ stage: 'user_identity', code: 'network_error', status: undefined, reply: () => new Error('private-network-url') },
	];
	it.each(githubFailures)('safely diagnoses GitHub $stage / $code / $status', async ({ stage, code, status, reply }) => {
		const { approved, githubUrl, client } = await beginLogin();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		let calls = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			calls++;
			if (stage === 'user_identity' && calls === 1) return Response.json({ access_token: 'private-access-token', token_type: 'bearer' });
			const result = reply();
			if (result instanceof Error) throw result;
			return result;
		});
		const response = await call(`/oauth/github/callback?code=private-code&state=${githubUrl.searchParams.get('state')}`,
			{ headers: { cookie: cookie(approved) } });
		expect(response.status).toBe(502);
		expect(await response.text()).toBe('GitHub authentication failed');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('X-Staging-Auth-Stage')).toBe(stage);
		expect(response.headers.get('X-Staging-Auth-Code')).toBe(code);
		expect(response.headers.get('X-Staging-Auth-HTTP-Status')).toBe(status === undefined ? null : String(status));
		expect(calls).toBe(stage === 'token_exchange' ? 1 : 2);
		expect(warn).toHaveBeenCalledExactlyOnceWith('staging_github_auth_failed', { stage, code, ...(status === undefined ? {} : { httpStatus: status }) });
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-|client_id|secret|verifier|https:|state/);
		const grants = await testEnv.OAUTH_KV.list({ prefix: 'grant:nora:' });
		const records = await Promise.all(grants.keys.map(key => testEnv.OAUTH_KV.get(key.name, 'json')));
		expect(records).not.toContainEqual(expect.objectContaining({ clientId: client.client_id }));
	});
	it('reproduces the provider invalid_target at parseAuthRequest for the observed origin', async () => {
		const { params } = await consent();
		params.set('resource', origin);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ctx = createExecutionContext();
		// Intentionally bypass the compatibility boundary to prove the provider contract.
		const response = await createStagingOAuthProvider(testEnv, worker.fetch).fetch(new Request(`${origin}/authorize?${params}`), testEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		expect(warn).toHaveBeenCalledWith('staging_oauth_rejected', { stage: 'authorize.parse', code: 'invalid_target' });
	});
	it('accepts the observed ChatGPT origin resource and keeps the grant bound to /mcp', async () => {
		const { callback, client } = await login(12345, origin);
		expect(callback.status).toBe(302);
		const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
		const response = await exchange(client.client_id, code, { resource: origin });
		expect(response.status).toBe(200);
		const tokens = await response.json() as Tokens;
		expect((await rpc(tokens.access_token, 'tools/list')).status).toBe(200);
		expect((await rpc(tokens.access_token, 'events/list')).status).toBe(200);
		const grants = await testEnv.OAUTH_KV.list({ prefix: 'grant:nora:' });
		const records = await Promise.all(grants.keys.map(key => testEnv.OAUTH_KV.get(key.name, 'json')));
		expect(records).toContainEqual(expect.objectContaining({ clientId: client.client_id, resource }));
		const refresh = await call('/oauth/token', { method: 'POST', body: new URLSearchParams({
			grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: origin }) });
		expect(refresh.status).toBe(200);
	});

	it('does not canonicalize other origins, paths, ambiguous resources or unrelated requests', async () => {
		for (const value of [ `${origin}/`, `${origin}/other`, `${origin}.attacker.example`,
			'http://personal-ai-os-staging.noradev.workers.dev', `${origin}?x=1`, `${origin}#mcp` ]) {
			const { page } = await consent({ resource: value });
			expect(page.status).toBe(400);
		}
		const { params } = await consent();
		params.set('resource', origin);
		params.append('resource', 'https://attacker.example');
		expect((await call(`/authorize?${params}`)).status).toBe(400);
		for (const path of ['/mcp', '/oauth/register', '/oauth/github/callback']) {
			const request = new Request(`${origin}${path}?resource=${encodeURIComponent(origin)}`);
			expect(await canonicalizeStagingOAuthResource(request, origin)).toBe(request);
		}
		const request = new Request(`https://attacker.example/authorize?resource=${encodeURIComponent(origin)}`);
		expect(await canonicalizeStagingOAuthResource(request, origin)).toBe(request);
	});

	it('logs only the failing stage and safe OAuth code, never request details', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { page } = await consent({ resource: 'https://attacker.example', state: 'private-client-state' });
		expect(page.status).toBe(400);
		expect(warn).toHaveBeenCalledWith('staging_oauth_rejected', { stage: 'authorize.parse', code: 'invalid_target' });
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-client-state|attacker|client_id|code_challenge/);
	});

	it('retains POST Origin enforcement for an origin-resource authorization', async () => {
		const { page } = await consent({ resource: origin });
		// Fetch Standard: no-referrer makes non-CORS form POST Origin null.
		expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
		const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1];
		for (const value of ['null', 'https://attacker.example', '']) {
			const response = await call('/authorize', { method: 'POST', headers: { origin: value, cookie: cookie(page) },
				body: new URLSearchParams({ handle, decision: 'approve' }) });
			expect(response.status).toBe(403);
		}
	});
	it('publishes discovery and rejects missing/invalid/static credentials', async () => {
		const denied = await call('/mcp', { method: 'POST' });
		expect(denied.status).toBe(401);
		expect(denied.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
		const metadataUrl = denied.headers.get('WWW-Authenticate')!.match(/resource_metadata="([^"]+)"/)![1];
		const metadata = await (await call(new URL(metadataUrl).pathname)).json() as { resource: string; authorization_servers: string[] };
		expect(metadata.resource).toBe(resource);
		expect(metadata.authorization_servers).toEqual([origin]);
		const server = await (await call('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
		expect(server.issuer).toBe(origin);
		expect(server.code_challenge_methods_supported).toEqual(['S256']);
		expect(server.authorization_response_iss_parameter_supported).toBe(true);
		expect(server.registration_endpoint).toBe(`${origin}/oauth/register`);
		expect((await rpc('invalid-token')).status).toBe(401);
		expect((await rpc(testEnv.MCP_AUTH_TOKEN)).status).toBe(401);
	});

	it('rejects unapproved redirect URIs, wrong resources, missing PKCE and unsupported scopes', async () => {
		expect((await register(['https://attacker.example/callback'])).status).toBe(400);
		const invalid: Record<string, string>[] = [ { redirect_uri: 'https://attacker.example/callback' }, { resource: 'https://other.example/mcp' },
			{ code_challenge_method: 'plain' }, { code_challenge: '', code_challenge_method: '' }, { scope: `${scopes} admin` } ];
		for (const extra of invalid) {
			const { page } = await consent(extra);
			expect(page.status).toBe(400);
			expect(page.headers.get('location')).toBeNull();
		}
	});

	it('escapes consent metadata, requires browser-bound consent, and supports deny', async () => {
		const { page } = await consent();
		const html = await page.text();
		expect(html).not.toContain('<script>evil</script>');
		expect(html).toContain('chatgpt.com');
		expect(page.headers.get('X-Frame-Options')).toBe('DENY');
		const handle = html.match(/name="handle" value="([^"]+)"/)![1];
		expect((await call('/authorize', { method: 'POST', headers: { origin },
			body: new URLSearchParams({ handle, decision: 'approve' }) })).status).toBe(400);
		const second = await consent();
		const secondHandle = (await second.page.text()).match(/name="handle" value="([^"]+)"/)![1];
		const denied = await call('/authorize', { method: 'POST', headers: { origin, cookie: cookie(second.page) },
			body: new URLSearchParams({ handle: secondHandle, decision: 'deny' }) });
		expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
	});

	it('rejects another GitHub user and callbacks without browser state', async () => {
		expect((await login(99999)).callback.status).toBe(403);
		expect((await call('/oauth/github/callback?code=stolen&state=invalid')).status).toBe(400);
	});

	it('issues resource-bound tokens, serves MCP tools/events, refreshes and expires access', async () => {
		const { tokens, client } = await obtainTokens();
		expect(tokens.expires_in).toBe(900);
		for (const method of ['server/discover', 'events/list', 'tools/list']) {
			const response = await rpc(tokens.access_token, method);
			expect(response.status).toBe(200);
			expect(await response.text()).not.toContain('"error"');
		}
		const refresh = await call('/oauth/token', { method: 'POST', body: new URLSearchParams({
			grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource }) });
		expect(refresh.status).toBe(200);
		const refreshed = await refresh.json() as Tokens;
		expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
		expect((await rpc(refreshed.access_token)).status).toBe(200);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 901_000);
		expect((await rpc(tokens.access_token)).status).toBe(401);
	});

	it('rejects authorization-code replay and revokes the affected grant', async () => {
		const { tokens, client, code } = await obtainTokens();
		expect((await exchange(client.client_id, code)).status).toBe(400);
		expect((await rpc(tokens.access_token)).status).toBe(401);
	});

	it('rejects stale account permissions for both access and refresh tokens', async () => {
		const { tokens, client } = await obtainTokens();
		const revokedEnv = { ...testEnv, OAUTH_ALLOWED_GITHUB_ID: '99999' };
		expect((await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } }, revokedEnv)).status).toBe(403);
		const response = await call('/oauth/token', { method: 'POST', body: new URLSearchParams({
			grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource }) }, revokedEnv);
		expect(response.status).toBe(400);
	});

	it('enforces scopes after refresh narrows a grant', async () => {
		const { tokens, client } = await obtainTokens();
		const response = await call('/oauth/token', { method: 'POST', body: new URLSearchParams({
			grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token,
			resource, scope: 'mcp:tools' }) });
		expect(response.status).toBe(200);
		const narrowed = await response.json() as Tokens;
		expect((await rpc(narrowed.access_token)).status).toBe(403);
	});

	it('fails closed for absent credentials and spoofed OAuth origins', async () => {
		expect((await call('/mcp', {}, { ...testEnv, OAUTH_ALLOWED_GITHUB_ID: '' })).status).toBe(503);
		const ctx = createExecutionContext();
		const response = await staging.fetch(new Request('https://attacker.example/.well-known/oauth-authorization-server'), testEnv, ctx);
		expect(response.status).toBe(400);
		await waitOnExecutionContext(ctx);
	});

	it('rejects wrong verifier and audience during code exchange', async () => {
		const invalid: Record<string, string>[] = [{ code_verifier: 'wrong' }, { resource: 'https://attacker.example' }];
		for (const options of invalid) {
			const { callback, client } = await login();
			const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
			expect((await exchange(client.client_id, code, options)).status).toBe(400);
		}
	});

	it('keeps events subscribe/challenge/unsubscribe behind OAuth', async () => {
		const { tokens } = await obtainTokens();
		const callback = 'https://callback.example.com';
		const customEnv = { ...testEnv, MCP_CALLBACK_ORIGIN: callback };
		const params = { name: 'notion.page_properties_updated', arguments: { data_source_id: '95af6fad-798f-4d0a-b370-356646a5745d' },
			delivery: { mode: 'webhook', url: `${callback}/events`, secret: `whsec_${btoa('12345678901234567890123456789012')}` } };
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			expect(new Headers(init?.headers).get('webhook-signature')).toMatch(/^v1,/);
			const body = JSON.parse(String(init?.body)) as { challenge: string };
			return Response.json({ challenge: body.challenge });
		});
		const request = { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' } };
		const response = await call('/mcp', { ...request, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params }) }, customEnv);
		expect(await response.json()).toMatchObject({ result: { id: expect.stringMatching(/^sub_/), cursor: null } });
		expect(fetchMock).toHaveBeenCalledOnce();
		const unsubscribed = await call('/mcp', { ...request, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'events/unsubscribe', params }) }, customEnv);
		expect(await unsubscribed.json()).toMatchObject({ result: {} });
	});
});
