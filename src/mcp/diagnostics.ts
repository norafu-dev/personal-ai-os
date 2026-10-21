// Only src/staging.ts creates an observer. Shared/production paths default to no observer.
const methods = ['unclassified', 'server/discover', 'events/list', 'events/subscribe', 'events/unsubscribe', 'other'] as const;
const stages = ['ingress', 'authentication', 'rpc_parse', 'authenticated_dispatch', 'arguments_validation',
	'callback_origin_validation', 'subscription_identity', 'subscription_lookup', 'challenge_cache', 'challenge_signing',
	'challenge_transport', 'challenge_http', 'challenge_json', 'challenge_echo', 'subscription_persist', 'rpc_end'] as const;
const reasons = ['received', 'passed', 'http_rejected', 'http_returned', 'invalid_json', 'invalid_request',
	'invalid_event', 'invalid_arguments', 'invalid_delivery', 'invalid_secret', 'invalid_ttl', 'invalid_cursor',
	'invalid_url', 'invalid_configured_origin', 'https_required', 'origin_mismatch', 'unsafe_url', 'storage_failure',
	'internal_error', 'timeout', 'connection_failed', 'non_2xx', 'invalid_echo', 'skipped_verified', 'success'] as const;
export type DiagnosticStage = typeof stages[number];
export type DiagnosticReason = typeof reasons[number];
type DiagnosticMethod = typeof methods[number];
type DiagnosticOutcome = 'received' | 'passed' | 'success' | 'rejected' | 'internal_error' | 'completed' | 'failed';
export type DiagnosticRecord = {
	schema: 'staging_mcp_diag_v1'; time: string; correlation_id: string; method: DiagnosticMethod;
	stage: DiagnosticStage; outcome: DiagnosticOutcome; reason: DiagnosticReason;
	rpc_code?: number; http_status?: number;
};
export interface McpDiagnostics {
	enter(stage: DiagnosticStage): void;
	passed(reason?: DiagnosticReason, httpStatus?: number): void;
	failed(reason: DiagnosticReason, httpStatus?: number): void;
	method(value: unknown): void;
	rpc(code?: number): void;
	finish(httpStatus: number): void;
}
const rpcCodes = new Set([-32700, -32600, -32602, -32603, -32015]);
function httpStatus(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

// The sink never receives caller objects or free-form strings. Failure is observational only.
export function createStagingDiagnostics(enabled: boolean, sink: (entry: DiagnosticRecord) => void = entry => console.log(entry)): McpDiagnostics | undefined {
	if (!enabled) return undefined;
	try {
		const correlation = crypto.randomUUID();
		let stage: DiagnosticStage = 'ingress';
		let method: DiagnosticMethod = 'unclassified';
		let reason: DiagnosticReason = 'received';
		let failed = false;
		let rpcCode: number | undefined;
		let rpcCompleted = false;
		let ended = false;
		let count = 0;
		const emit = (outcome: DiagnosticOutcome, status?: number, terminal = false) => {
			if (ended || (!terminal && count >= 15)) return; // Reserve the sixteenth slot for the end record.
			if (terminal) ended = true;
			count++;
			try {
				const entry: DiagnosticRecord = { schema: 'staging_mcp_diag_v1', time: new Date().toISOString(),
					correlation_id: correlation, method, stage, outcome, reason,
					...(rpcCode === undefined ? {} : { rpc_code: rpcCode }),
					...(httpStatus(status) ? { http_status: status } : {}) };
				if (new TextEncoder().encode(JSON.stringify(entry)).byteLength <= 1024) sink(entry);
			} catch { /* Never affect the request, including when the logger fails. */ }
		};
		emit('received');
		return {
			enter(value) { if (!ended && !failed && stages.some(item => item === value)) { stage = value; reason = 'passed'; } },
			passed(value = 'passed', status) {
				if (!ended && !failed && reasons.some(item => item === value)) { reason = value; emit('passed', status); }
			},
			failed(value, status) {
				if (!ended && !failed && reasons.some(item => item === value)) { failed = true; reason = value; emit('failed', status); }
			},
			method(value) { if (!ended) method = methods.find(item => item !== 'unclassified' && item !== 'other' && item === value) ?? 'other'; },
			rpc(code) {
				if (ended) return;
				rpcCompleted = true;
				if (code !== undefined && rpcCodes.has(code)) {
					rpcCode = code;
					if (!failed) { failed = true; reason = 'internal_error'; }
				} else if (code === undefined && !failed) { stage = 'rpc_end'; reason = 'success'; }
			},
			finish(status) {
				if (!failed && status >= 400) { failed = true; reason = 'http_rejected'; }
				if (!failed && !rpcCompleted) reason = 'http_returned';
				emit(failed ? (reason === 'internal_error' || reason === 'storage_failure' ? 'internal_error' : 'rejected')
					: rpcCompleted ? 'success' : 'completed', status, true);
			},
		};
	} catch { return undefined; }
}

export async function diagnosticOperation<T>(observer: McpDiagnostics | undefined, stage: DiagnosticStage,
	operation: () => Promise<T>, failure: DiagnosticReason = 'internal_error'): Promise<T> {
	observer?.enter(stage);
	try { const result = await operation(); observer?.passed(); return result; }
	catch (error) { observer?.failed(failure); throw error; }
}
