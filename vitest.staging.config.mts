import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));

			return {
				wrangler: { configPath: './wrangler.jsonc', environment: 'staging' },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						OAUTH_GITHUB_CLIENT_ID: 'test-github-client',
						OAUTH_GITHUB_CLIENT_SECRET: 'test-github-secret',
						OAUTH_ALLOWED_GITHUB_ID: '12345',
					},
				},
			};
		}),
	],
	test: {
		setupFiles: ['./test/apply-migrations.ts'],
	},
});
