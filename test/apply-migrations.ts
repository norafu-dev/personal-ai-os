import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';

declare module 'cloudflare:test' {
	interface ProvidedEnv {
		TEST_MIGRATIONS: D1Migration[];
	}
}

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
