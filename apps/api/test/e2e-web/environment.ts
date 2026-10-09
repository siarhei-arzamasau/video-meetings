import { browserSuiteDatabaseUrl } from '../utils/test-database';

/**
 * The environment only the browser suite's API has, set before anything imports `AppModule`:
 * `ConfigModule.forRoot()` is evaluated at that import and prefers `process.env`, which is
 * also why this is a module `main.ts` imports first rather than lines at the top of it.
 *
 * **The setting, the token, and the scripted Claude are one decision, made in one place.**
 * With `MEETING_DIGEST_ENABLED` on, the API will not boot without `ANTHROPIC_AUTH_TOKEN` —
 * and the suite is run with that variable exported empty, to prove it needs none. So the
 * token here is a placeholder nothing can spend: `main.ts` binds `ScriptedClaudeAgent` over
 * the one service that would read it, and no process of the SDK's is ever started. Setting
 * the three anywhere they could be changed apart — the setting in `start:e2e-web`, say —
 * leaves a way to switch the digest on over the real `ClaudeAgentService`, where every
 * recording the browser specs transcribe would be a paid request.
 */
export const E2E_WEB_PLACEHOLDER_TOKEN = 'e2e-web-placeholder-not-a-token';

process.env['MEETING_DIGEST_ENABLED'] = 'true';
process.env['ANTHROPIC_AUTH_TOKEN'] = E2E_WEB_PLACEHOLDER_TOKEN;

/**
 * A database of the suite's own. Its teardown empties `users` and everything that hangs off
 * it, and until this line it did so in whatever database `DATABASE_URL` named — on a set-up
 * machine, the development one. `main.ts` creates and migrates the database before the
 * application connects to it.
 */
process.env['DATABASE_URL'] = browserSuiteDatabaseUrl();
