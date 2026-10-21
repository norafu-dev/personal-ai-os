import { env, createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStagingDiagnostics, type DiagnosticRecord } from '../src/mcp/diagnostics';
import { handleAuthenticatedMcpHttp } from '../src/mcp/http';
import { NOTION_CONFIG } from '../src/config/notion';
import staging from '../src/staging';
import worker from '../src/index';
import type { StagingOAuthEnv } from '../src/auth/staging-oauth';
const origin = 'https://callback.example.com';
const sentinel = 'PRIVATE_SENTINEL_83fe';
const secret = `whsec_${btoa('12345678901234567890123456789012')}`;
const args = { data_source_id: [...NOTION_CONFIG.managedDataSourceIds][0] };
const params = { name: 'notion.page_properties_updated', arguments: args,
 delivery: { mode: 'webhook', url: `${origin}/${sentinel}?token=${sentinel}`, secret } };
const config = { DB: env.DB, MCP_CALLBACK_ORIGIN: origin, NOTION_API_KEY: 'test-notion-key' };
const principal = { owner: 'nora', token: sentinel, scopes: ['mcp:tools', 'mcp:events'] };
function trace() {
 const records: DiagnosticRecord[] = [];
 const observer = createStagingDiagnostics(true, entry => records.push(entry))!;
 return { records, observer };
}
async function request(value: unknown, customConfig = config, observed = trace()) {
 const response = await handleAuthenticatedMcpHttp(new Request('https://example.com/mcp', { method: 'POST',
  headers: { authorization: `Bearer ${sentinel}`, cookie: sentinel, 'content-type': 'application/json' },
  body: typeof value === 'string' ? value : JSON.stringify(value) }), customConfig, principal, observed.observer);
 observed.observer.finish(response.status);
 return { response, payload: await response.json(), ...observed };
}
function rpc(overrides: Record<string, unknown> = {}) {
 return { jsonrpc: '2.0', id: sentinel, method: 'events/subscribe', params: { ...params, ...overrides } };
}
const echo = async (_input: RequestInfo | URL, init?: RequestInit) => Response.json({ challenge: JSON.parse(String(init?.body)).challenge });
function assertSafe(records: DiagnosticRecord[]) {
 const serialized = JSON.stringify(records);
 for (const privateValue of [sentinel, encodeURIComponent(sentinel), secret, origin]) expect(serialized).not.toContain(privateValue);
 expect(records.length).toBeLessThanOrEqual(16);
 expect(new Set(records.map(entry => entry.correlation_id)).size).toBe(1);
 for (const entry of records) {
  expect(Object.keys(entry).every(key => ['schema','time','correlation_id','method','stage','outcome','reason','rpc_code','http_status'].includes(key))).toBe(true);
  expect(entry.schema).toBe('staging_mcp_diag_v1');
  expect(entry.correlation_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(Number.isNaN(Date.parse(entry.time))).toBe(false);
  expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBeLessThanOrEqual(1024);
 }
}
beforeEach(async () => {
 await env.DB.prepare('DELETE FROM mcp_event_deliveries').run();
 await env.DB.prepare('DELETE FROM mcp_event_subscriptions').run();
});
afterEach(() => vi.restoreAllMocks());

describe('Staging diagnostic contract', () => {
 it('bounds output, reserves exactly one terminal record, and ignores untrusted runtime fields', () => {
  const { observer, records } = trace();
  observer.method(sentinel);
  Reflect.apply(observer.enter, observer, [sentinel]);
  Reflect.apply(observer.passed, observer, [sentinel]);
  for (let i = 0; i < 40; i++) observer.passed();
  observer.rpc(); observer.finish(200); observer.finish(503); observer.passed();
  expect(records).toHaveLength(16);
  expect(records.at(-1)).toMatchObject({stage:'rpc_end',outcome:'success',http_status:200,method:'other'});
  expect(records.filter(entry => entry.outcome === 'success')).toHaveLength(1);
  assertSafe(records);
 });
 it('does not let a throwing logger change RPC success or failure', async () => {
  const observer = createStagingDiagnostics(true, () => { throw new Error(sentinel); })!;
  const success = await request({jsonrpc:'2.0',id:1,method:'events/list'}, config, { observer, records:[] });
  expect(success.payload).toHaveProperty('result.events');
  const failure = await request(rpc({ttlMs:-1}), config, {observer:createStagingDiagnostics(true, () => {throw new Error(sentinel);})!,records:[]});
  expect(failure.payload).toHaveProperty('error.code',-32602);
 });
 it.each([
  {body:'{',reason:'invalid_json',code:-32700},
  {body:[],reason:'invalid_request',code:-32600},
  {body:{jsonrpc:'2.0',id:1},reason:'invalid_request',code:-32600},
 ])('keeps parsing errors safe: $reason', async ({body,reason,code}) => {
  const {payload,records} = await request(body);
  expect(payload).toHaveProperty('error.code',code);
  expect(records.at(-1)).toMatchObject({stage:'rpc_parse',reason,rpc_code:code,http_status:200,outcome:'rejected'});
  assertSafe(records);
 });
 it.each([
  {overrides:{name:sentinel},reason:'invalid_event'},
  {overrides:{arguments:{data_source_id:sentinel}},reason:'invalid_arguments'},
  {overrides:{delivery:{mode:'stream',url:sentinel}},reason:'invalid_delivery'},
  {overrides:{delivery:{...params.delivery,secret:sentinel}},reason:'invalid_secret'},
  {overrides:{ttlMs:-1},reason:'invalid_ttl'},
  {overrides:{cursor:{}},reason:'invalid_cursor'},
 ])('rejects arguments without callback access: $reason', async ({overrides,reason}) => {
  const transport = vi.spyOn(globalThis,'fetch');
  const {payload,records} = await request(rpc(overrides));
  expect(payload).toHaveProperty('error.code',-32602);
  expect(records.at(-1)).toMatchObject({stage:'arguments_validation',reason,rpc_code:-32602});
  expect(transport).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT COUNT(*) FROM mcp_event_subscriptions').first('COUNT(*)')).toBe(0);
  assertSafe(records);
 });
 it.each([
  {url:sentinel,reason:'invalid_url'},
  {url:`http://callback.example.com/${sentinel}`,reason:'https_required'},
  {url:`https://elsewhere.example.com/${sentinel}`,reason:'origin_mismatch'},
  {url:`https://${sentinel}@callback.example.com/x`,reason:'unsafe_url'},
 ])('classifies callback rejection: $reason', async ({url,reason}) => {
  const transport = vi.spyOn(globalThis,'fetch');
  const {records,payload} = await request(rpc({delivery:{...params.delivery,url}}));
  expect(payload).toHaveProperty('error.code',-32602);
  expect(records.at(-1)).toMatchObject({stage:'callback_origin_validation',reason});
  expect(transport).not.toHaveBeenCalled(); assertSafe(records);
 });
 it('classifies a malformed configured origin', async () => {
  const {records} = await request(rpc(),{...config,MCP_CALLBACK_ORIGIN:sentinel});
  expect(records.at(-1)).toMatchObject({stage:'callback_origin_validation',reason:'invalid_configured_origin'});
 });
 it.each([301,307,400,403,429,500,503])('records callback HTTP %s separately from RPC HTTP 200', async status => {
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(sentinel,{status,headers:{location:`https://private.example/${sentinel}`}}));
  const {records,payload} = await request(rpc());
  expect(payload).toHaveProperty('error.code',-32015);
  expect(payload).toHaveProperty('error.data.reason','challenge_failed');
  expect(records).toContainEqual(expect.objectContaining({stage:'challenge_http',reason:'non_2xx',http_status:status}));
  expect(records.at(-1)).toMatchObject({stage:'challenge_http',reason:'non_2xx',rpc_code:-32015,http_status:200});
  expect(records.some(entry => entry.stage === 'subscription_persist')).toBe(false); assertSafe(records);
 });
 it.each([
  {stage:'challenge_transport',reason:'timeout',reply:async () => {throw new DOMException(sentinel,'TimeoutError');}},
  {stage:'challenge_transport',reason:'connection_failed',reply:async () => {throw new Error(sentinel);}},
  {stage:'challenge_json',reason:'invalid_json',reply:async () => new Response(sentinel)},
  {stage:'challenge_echo',reason:'invalid_echo',reply:async () => Response.json({challenge:sentinel})},
 ])('records $stage / $reason without sensitive exceptions or bodies', async ({stage,reason,reply}) => {
  const channels = ['log','info','warn','error','debug','trace','dir','table'] as const;
  const spies = channels.map(channel => vi.spyOn(console,channel).mockImplementation(() => {}));
  vi.spyOn(globalThis,'fetch').mockImplementation(reply);
  const {records,payload} = await request(rpc());
  expect(payload).toHaveProperty('error.code',-32015);
  expect(records.at(-1)).toMatchObject({stage,reason});
  expect(records.some(entry => entry.stage === 'subscription_persist')).toBe(false);
  expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain(sentinel); assertSafe(records);
 });
 it('distinguishes signing failure internally while keeping the original RPC error', async () => {
  vi.spyOn(crypto.subtle,'sign').mockRejectedValueOnce(new Error(sentinel));
  const transport = vi.spyOn(globalThis,'fetch');
  const {records,payload} = await request(rpc());
  expect(payload).toHaveProperty('error.data.reason','connection_failed');
  expect(records.at(-1)).toMatchObject({stage:'challenge_signing',reason:'internal_error',rpc_code:-32015});
  expect(transport).not.toHaveBeenCalled(); assertSafe(records);
 });
 it.each(['lookup','persist'])('records D1 %s failure at the actual stage and never success', async operation => {
  vi.spyOn(globalThis,'fetch').mockImplementation(echo);
  const original = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB,'prepare').mockImplementation(sql => {
   if (operation === 'lookup' && sql.startsWith('SELECT * FROM mcp_event_subscriptions') || operation === 'persist' && sql.includes('INSERT INTO mcp_event_subscriptions')) throw new Error(sentinel);
   return original(sql);
  });
  const {records,payload} = await request(rpc());
  expect(payload).toHaveProperty('error.code',-32603);
  expect(records.at(-1)).toMatchObject({stage:operation === 'lookup' ? 'subscription_lookup' : 'subscription_persist',reason:'storage_failure',outcome:'internal_error',rpc_code:-32603});
  expect(records.some(entry => entry.outcome === 'success')).toBe(false); assertSafe(records);
 });
 it('traces successful persistence, cache refresh and unsubscribe with unchanged result bodies', async () => {
  const transport = vi.spyOn(globalThis,'fetch').mockImplementation(echo);
  const first = await request(rpc());
  expect(first.payload).toHaveProperty('result.cursor',null);
  expect(first.records).toContainEqual(expect.objectContaining({stage:'subscription_persist',outcome:'passed'}));
  expect(first.records.at(-1)).toMatchObject({stage:'rpc_end',outcome:'success'});
  const second = await request(rpc());
  expect(second.payload).toHaveProperty('result.id');
  expect(second.records).toContainEqual(expect.objectContaining({stage:'challenge_cache',reason:'skipped_verified'}));
  expect(transport).toHaveBeenCalledTimes(1);
  const unsub = await request({...rpc(),method:'events/unsubscribe'});
  expect(unsub.payload).toHaveProperty('result',{});
  for (const records of [first.records,second.records,unsub.records]) assertSafe(records);
 });
 it('keeps concurrent request correlations independent', async () => {
  vi.spyOn(globalThis,'fetch').mockImplementation(echo);
  const results = await Promise.all(['a','b'].map(path => request(rpc({delivery:{...params.delivery,url:`${origin}/${path}`}}))));
  expect(new Set(results.flatMap(result => result.records.map(entry => entry.correlation_id))).size).toBe(2);
  results.forEach(result => { expect(result.payload).toHaveProperty('result.id'); assertSafe(result.records); });
 });
 it('emits nothing from the original entry even when the diagnostics variable is set', async () => {
  const output = vi.spyOn(console,'log').mockImplementation(() => {});
  const response = await worker.fetch(new Request('https://example.com/mcp',{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/list'})}),
   {...env,NOTION_API_KEY:'test',NOTION_DATA_SOURCE_ID:'test',NOTION_WEBHOOK_SECRET:'test',MCP_AUTH_TOKEN:'test-token',MCP_CALLBACK_ORIGIN:origin,MCP_EVENTS_DIAGNOSTICS:'1'},createExecutionContext());
  expect(response.status).toBe(200); expect(output).not.toHaveBeenCalled();
 });
 it('gates unauthenticated ingress by the Staging switch without parsing private bodies', async () => {
  const output = vi.spyOn(console,'log').mockImplementation(() => {});
  const testEnv: StagingOAuthEnv = {...env,OAUTH_GITHUB_CLIENT_ID:'test-client',OAUTH_GITHUB_CLIENT_SECRET:'test-secret',OAUTH_ALLOWED_GITHUB_ID:'12345'};
  const make = () => new Request(`${env.OAUTH_ISSUER}/mcp?private=${sentinel}`,{method:'POST',headers:{authorization:`Bearer ${sentinel}`,cookie:sentinel},body:sentinel});
  const disabled = await staging.fetch(make(),{...testEnv,MCP_EVENTS_DIAGNOSTICS:'0'},createExecutionContext());
  expect(disabled.status).toBe(401); expect(output).not.toHaveBeenCalled();
  const enabled = await staging.fetch(make(),{...testEnv,MCP_EVENTS_DIAGNOSTICS:'1'},createExecutionContext());
  expect(enabled.status).toBe(401);
  expect(JSON.stringify(output.mock.calls)).not.toContain(sentinel);
  expect(output.mock.calls.at(-1)?.[0]).toMatchObject({stage:'authentication',outcome:'rejected',http_status:401});
 });
});
