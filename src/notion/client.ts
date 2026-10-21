import { Client } from '@notionhq/client';

export function createNotionClient(auth: string, fetch?: typeof globalThis.fetch): Client {
	return new Client({
		auth,
		...(fetch ? { fetch } : {}),
		// The SDK treats any runtime with WorkerGlobalScope as a browser. A Worker
		// runs server-side and the token comes from a secret, so this is safe here.
		dangerouslyAllowBrowser: true,
		// Keep tool calls within ChatGPT's patience; one retry for 429/5xx.
		retry: { maxRetries: 1 },
		timeoutMs: 15_000,
	});
}
