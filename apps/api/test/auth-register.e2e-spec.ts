import {
  EMAIL,
  LONG_PASSWORD,
  MAX_EMAIL_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  MIN_PASSWORD_LENGTH,
  PASSWORD,
  REGISTER_URL,
  TEST_JWT_SECRET,
} from './utils/fixtures';
import { accessTokenOf } from './utils/http';
import { verifyJwtHs256 } from './utils/jwt';
import { useAuthSuite } from './utils/auth-suite';
import { countUsers, findUserRow } from './utils/users-table';

describe(`POST ${REGISTER_URL}`, () => {
  const suite = useAuthSuite();

  const register = (body: object) => suite.post(REGISTER_URL, body);

  describe('a valid registration', () => {
    it('creates a user and returns a token', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(201);
      expect(accessTokenOf(response)).not.toHaveLength(0);
      expect(await countUsers(suite.prisma())).toBe(1);
    });

    it('returns the token as the only field in the body', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD }).expect(201);

      expect(Object.keys(response.body as object)).toEqual(['accessToken']);
    });

    it('accepts a password of exactly the minimum length', async () => {
      // The other side of the boundary. Without this, @MinLength(20) passes the suite.
      await register({ email: EMAIL, password: 'a'.repeat(MIN_PASSWORD_LENGTH) }).expect(201);
    });

    it('accepts a password longer than the 72 bytes bcrypt would truncate', async () => {
      await register({ email: EMAIL, password: LONG_PASSWORD }).expect(201);
    });

    it('stamps a creation time', async () => {
      const before = Date.now();

      await register({ email: EMAIL, password: PASSWORD }).expect(201);

      const { created_at: createdAt } = await findUserRow(suite.prisma(), EMAIL);

      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    });
  });

  describe('email normalisation', () => {
    it('stores the email lowercased and trimmed', async () => {
      await register({ email: '  Ada@Example.COM  ', password: PASSWORD }).expect(201);

      const row = await findUserRow(suite.prisma(), EMAIL);

      expect(row.email).toBe(EMAIL);
    });

    it('rejects an email that differs from an existing one only by case', async () => {
      await register({ email: EMAIL, password: PASSWORD }).expect(201);

      const response = await register({ email: 'ADA@EXAMPLE.COM', password: PASSWORD });

      expect(response.status).toBe(409);
      expect(await countUsers(suite.prisma())).toBe(1);
    });
  });

  describe('the derived display name', () => {
    it.each([
      ['a dotted local part', 'ada.lovelace@example.com', 'ada.lovelace'],
      ['a tagged address', 'ada+test@example.com', 'ada+test'],
      ['an uppercase address', 'Ada@Example.com', 'ada'],
    ])('comes from the local part of %s', async (_description, email, expected) => {
      await register({ email, password: PASSWORD }).expect(201);

      const row = await findUserRow(suite.prisma(), email.trim().toLowerCase());

      expect(row.display_name).toBe(expected);
    });
  });

  describe('password storage', () => {
    it('stores a hash rather than the password', async () => {
      await register({ email: EMAIL, password: PASSWORD }).expect(201);

      const row = await findUserRow(suite.prisma(), EMAIL);

      expect(row.password_hash).not.toBe(PASSWORD);
      expect(row.password_hash).not.toContain(PASSWORD);
      expect(row.password_hash).not.toHaveLength(0);
    });

    it('salts, so two users sharing a password do not share a hash', async () => {
      await register({ email: EMAIL, password: PASSWORD }).expect(201);
      await register({ email: 'grace@example.com', password: PASSWORD }).expect(201);

      const ada = await findUserRow(suite.prisma(), EMAIL);
      const grace = await findUserRow(suite.prisma(), 'grace@example.com');

      expect(ada.password_hash).not.toBe(grace.password_hash);
    });

    it('does not echo the password back', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD }).expect(201);

      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });
  });

  describe('the issued token', () => {
    it('verifies against the secret and identifies the new user', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD }).expect(201);
      const row = await findUserRow(suite.prisma(), EMAIL);

      const { payload } = verifyJwtHs256(accessTokenOf(response), TEST_JWT_SECRET);

      expect(payload['sub']).toBe(row.id);
    });

    it('expires, within a sane window', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD }).expect(201);

      const { payload } = verifyJwtHs256(accessTokenOf(response), TEST_JWT_SECRET);
      const now = Math.floor(Date.now() / 1_000);

      expect(typeof payload['iat']).toBe('number');
      expect(typeof payload['exp']).toBe('number');
      expect(Number(payload['exp'])).toBeGreaterThan(now);
      expect(Number(payload['exp'])).toBeLessThanOrEqual(now + MAX_TOKEN_LIFETIME_SECONDS);
    });

    it('carries neither the password nor its hash', async () => {
      const response = await register({ email: EMAIL, password: PASSWORD }).expect(201);
      const row = await findUserRow(suite.prisma(), EMAIL);

      const { payload } = verifyJwtHs256(accessTokenOf(response), TEST_JWT_SECRET);
      const serialised = JSON.stringify(payload);

      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain(row.password_hash);
    });
  });

  describe('a duplicate email', () => {
    it('is rejected', async () => {
      await register({ email: EMAIL, password: PASSWORD }).expect(201);

      const response = await register({ email: EMAIL, password: 'another-password-99' });

      expect(response.status).toBe(409);
    });

    it('leaves the first user untouched', async () => {
      await register({ email: EMAIL, password: PASSWORD }).expect(201);
      const original = await findUserRow(suite.prisma(), EMAIL);

      await register({ email: EMAIL, password: 'another-password-99' }).expect(409);

      const row = await findUserRow(suite.prisma(), EMAIL);

      expect(await countUsers(suite.prisma())).toBe(1);
      expect(row.password_hash).toBe(original.password_hash);
    });

    it('creates one user even when both requests arrive together', async () => {
      // A check-then-insert implementation passes the sequential tests above and fails
      // this one: only the database's unique constraint settles a genuine race.
      const responses = await Promise.all([
        register({ email: EMAIL, password: PASSWORD }),
        register({ email: EMAIL, password: PASSWORD }),
      ]);

      const statuses = responses.map((response) => response.status).toSorted((a, b) => a - b);

      expect(statuses).toEqual([201, 409]);
      expect(await countUsers(suite.prisma())).toBe(1);
    });
  });

  describe('validation', () => {
    const invalidBodies: Array<[description: string, body: object]> = [
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
      ['a blank email', { email: '', password: PASSWORD }],
      ['a whitespace-only email', { email: '   ', password: PASSWORD }],
      [
        'an email over the maximum length',
        { email: `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`, password: PASSWORD },
      ],
      [
        'a password one character below the minimum',
        { email: EMAIL, password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) },
      ],
      ['a whitespace-only password', { email: EMAIL, password: ' '.repeat(MIN_PASSWORD_LENGTH) }],
      ['a missing password', { email: EMAIL }],
      ['a missing email', { password: PASSWORD }],
      ['an empty body', {}],
      ['an unrecognised field', { email: EMAIL, password: PASSWORD, role: 'admin' }],
      // The global ValidationPipe runs with enableImplicitConversion, which would otherwise
      // coerce these into acceptable strings.
      ['a numeric password', { email: EMAIL, password: 12_345_678 }],
      ['a boolean password', { email: EMAIL, password: true }],
      ['a numeric email', { email: 123, password: PASSWORD }],
      ['an array email', { email: [EMAIL], password: PASSWORD }],
      ['an object password', { email: EMAIL, password: { value: PASSWORD } }],
    ];

    it.each(invalidBodies)('rejects %s with 400', async (_description, body) => {
      const response = await register(body);

      expect(response.status).toBe(400);
    });

    // Two representative cases rather than all of the above: once validation returns 400
    // the handler never ran, so repeating this per invalid body only costs runtime.
    const representativeBodies: Array<[description: string, body: object]> = [
      ['a malformed email', { email: 'not-an-email', password: PASSWORD }],
      ['an unrecognised field', { email: EMAIL, password: PASSWORD, role: 'admin' }],
    ];

    it.each(representativeBodies)('creates no user for %s', async (_description, body) => {
      await register(body).expect(400);

      expect(await countUsers(suite.prisma())).toBe(0);
    });
  });
});
