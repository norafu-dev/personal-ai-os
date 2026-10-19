import { signWebhookPayload } from '@notionhq/client';
import { loadEnvFile } from 'node:process';

const varsFile = process.env.STAGING_VARS_FILE ?? '.dev.vars.staging';

try {
	loadEnvFile(varsFile);
} catch (error) {
	throw new Error(`Unable to load ${varsFile}. Copy .dev.vars.staging.example first.`, { cause: error });
}

const target = new URL(process.env.NOTION_TEST_URL ?? 'http://127.0.0.1:8787/webhooks/notion');
const isLocal = target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';

if (!isLocal && !target.hostname.includes('staging')) {
	throw new Error('Refusing to send a synthetic event to a URL that is neither local nor explicitly named staging.');
}

const verificationToken = process.env.NOTION_WEBHOOK_SECRET;
const dataSourceId = process.env.NOTION_TEST_DATA_SOURCE_ID ?? process.env.NOTION_DATA_SOURCE_ID;

if (!verificationToken || !dataSourceId) {
	throw new Error('NOTION_WEBHOOK_SECRET and NOTION_TEST_DATA_SOURCE_ID (or NOTION_DATA_SOURCE_ID) are required.');
}

const eventId = `staging-${crypto.randomUUID()}`;
const body = JSON.stringify({
	id: eventId,
	type: 'page.properties_updated',
	entity: { id: `staging-page-${crypto.randomUUID()}`, type: 'page' },
	data: {
		parent: { id: 'staging-database', type: 'database', data_source_id: dataSourceId },
		updated_properties: ['staging-status'],
	},
});
const signature = await signWebhookPayload({ body, verificationToken });
const response = await fetch(target, {
	method: 'POST',
	headers: { 'content-type': 'application/json', 'x-notion-signature': signature },
	body,
});
const responseBody = await response.text();

console.log(JSON.stringify({ target: target.origin, eventId, status: response.status, response: responseBody }));

if (!response.ok) process.exitCode = 1;
