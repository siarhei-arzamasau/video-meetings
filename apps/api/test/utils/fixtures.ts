/**
 * Signing secret and lifetime every e2e run uses, applied to the environment by
 * `test/setup-env.ts` before anything imports the application.
 */
export const TEST_JWT_SECRET = 'e2e-only-secret-do-not-use-in-production';
export const TEST_JWT_EXPIRES_IN_SECONDS = 3600;

export const REGISTER_URL = '/api/auth/register';
export const LOGIN_URL = '/api/auth/login';
export const ME_URL = '/api/auth/me';
export const MEETINGS_URL = '/api/meetings';

export const EMAIL = 'ada@example.com';
export const PASSWORD = 'correct-horse-battery-42';

/** Second and third accounts, for the cases that need someone other than `EMAIL` to exist. */
export const OTHER_EMAIL = 'grace@example.com';
export const THIRD_EMAIL = 'charles@example.com';

/** Mirrors `CreateMeetingDto`. Declared here, not imported, so a relaxed bound fails a test. */
export const MAX_TITLE_LENGTH = 200;
export const MAX_PARTICIPANTS = 100;

/** The shortest password the API accepts. One character less must be a 400. */
export const MIN_PASSWORD_LENGTH = 8;

/** RFC 5321's maximum forward path. Anything longer must be a 400, not a 500. */
export const MAX_EMAIL_LENGTH = 254;

/** Upper bound on token lifetime. Guards against a token that expires so late it never does. */
export const MAX_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * bcrypt silently truncates at 72 bytes, which makes every password sharing a 72-byte
 * prefix the same credential. These two must never authenticate each other.
 */
export const LONG_PASSWORD = `${'a'.repeat(72)}-tail-one`;
export const LONG_PASSWORD_SAME_PREFIX = `${'a'.repeat(72)}-tail-two`;
