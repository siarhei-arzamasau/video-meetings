/**
 * How a raw environment string becomes the value the contract in `env.validation.ts` checks.
 * Kept apart from it so that file states what is required, and this one how it is read.
 */

/**
 * The env files the API reads, the first to name a variable winning. Exported so a suite that
 * builds its own `ConfigModule` reads a variable from the files `AppModule` would, not from
 * a list of its own that can drift.
 */
export const ENV_FILE_PATHS: string[] = ['.env.local', '.env'];

/** What `pnpm dev` serves the web app on when `WEB_PORT` says nothing else. */
const DEFAULT_WEB_PORT = 3000;

/**
 * An origin as a browser sends it: a scheme, a host, and an optional port — nothing after, not
 * even a slash. An entry with a path is compared exactly and so matches no request at all.
 */
export const ORIGIN_PATTERN = /^https?:\/\/[^/\s?#]+$/;

/**
 * `CORS_ORIGINS` as a list, split on commas and trimmed.
 *
 * Unset or blank outside production, it is the web app `pnpm dev` runs: `localhost` and
 * `127.0.0.1` on `WEB_PORT`, which `scripts/dev.mjs` hands both apps, so the default follows
 * the web app when that port was taken. Unset in production it is empty, which the contract
 * refuses: there is no origin a deployment could safely be assumed to serve.
 */
export function corsOriginsOf(
  configured: unknown,
  webPort: unknown,
  isProduction: boolean,
): string[] {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
  }

  if (isProduction) {
    return [];
  }

  const port = String(webPort ?? DEFAULT_WEB_PORT);

  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * `true`/`1` and `false`/`0`, in any case and with surrounding space ignored.
 *
 * `enableImplicitConversion` alone would read the string `'false'` as `Boolean('false')`,
 * which is `true`. Any other spelling is returned as-is, so `@IsBoolean` rejects it rather than
 * a typo quietly reading as one or the other.
 */
export function parseBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value;
  }

  switch (String(value).trim().toLowerCase()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      return value;
  }
}

/**
 * Signing keys this repository has published. Rejected by value because length alone cannot
 * catch them: the placeholder below is 44 characters, so it satisfies `@MinLength(32)` and a
 * deployment that never set `JWT_SECRET` would boot and sign real tokens with a key anybody
 * who has read the repository knows. User ids are not secret — they travel in meeting and
 * file payloads — so that key is an account-takeover primitive, not a weak default.
 */
export const PUBLISHED_JWT_SECRETS: readonly string[] = [
  'dev-only-replace-with-openssl-rand-base64-32',
];

export const GENERATE_SECRET_ADVICE = 'Generate one with `openssl rand -base64 32`.';

/** What `NODE_ENV` may be. Production is the one value the contract treats differently. */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}
