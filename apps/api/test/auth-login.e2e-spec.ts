import {
  EMAIL,
  LOGIN_URL,
  LONG_PASSWORD,
  LONG_PASSWORD_SAME_PREFIX,
  MAX_EMAIL_LENGTH,
  MAX_TOKEN_LIFETIME_SECONDS,
  PASSWORD,
  REGISTER_URL,
  TEST_JWT_SECRET,
} from './utils/fixtures';
import { accessTokenOf, messageOf } from './utils/http';
import { verifyJwtHs256 } from './utils/jwt';
import { useApiSuite } from './utils/api-suite';
import { countUsers, findUserRow, readUserSnapshot } from './utils/users-table';

const WRONG_PASSWORD = 'wrong-password-99';
const UNKNOWN_EMAIL = 'nobody@example.com';

describe(`POST ${LOGIN_URL}`, () => {
  const suite = useApiSuite();

  const login = (body: object) => suite.post(LOGIN_URL, body);
  const register = (body: object) => suite.post(REGISTER_URL, body);

  beforeEach(async () => {
    // Seeded through the API so login runs against a hash the API actually produced.
    await register({ email: EMAIL, password: PASSWORD }).expect(201);
  });

  describe('correct credentials', () => {
    it('return a token', async () => {
      const response = await login({ email: EMAIL, password: PASSWORD });

      expect(response.status).toBe(200);
      expect(accessTokenOf(response)).not.toHaveLength(0);
    });

    it('return the token as the only field in the body', async () => {
      const response = await login({ email: EMAIL, password: PASSWORD }).expect(200);

      expect(Object.keys(response.body as object)).toEqual(['accessToken']);
    });

    it('are accepted with the email in a different case', async () => {
      await login({ email: '  ADA@Example.COM  ', password: PASSWORD }).expect(200);
    });

    it('create no user', async () => {
      await login({ email: EMAIL, password: PASSWORD }).expect(200);

      expect(await countUsers(suite.prisma())).toBe(1);
    });

    it('leave every column of the stored row untouched', async () => {
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      await login({ email: EMAIL, password: PASSWORD }).expect(200);

      expect(await readUserSnapshot(suite.prisma(), EMAIL)).toEqual(before);
    });

    it('do not echo the password back', async () => {
      const response = await login({ email: EMAIL, password: PASSWORD }).expect(200);

      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });
  });

  describe('the issued token', () => {
    it('identifies the user already in the database', async () => {
      const row = await findUserRow(suite.prisma(), EMAIL);

      const response = await login({ email: EMAIL, password: PASSWORD }).expect(200);
      const { payload } = verifyJwtHs256(accessTokenOf(response), TEST_JWT_SECRET);

      expect(payload['sub']).toBe(row.id);
    });

    it('expires, within a sane window', async () => {
      const response = await login({ email: EMAIL, password: PASSWORD }).expect(200);

      const { payload } = verifyJwtHs256(accessTokenOf(response), TEST_JWT_SECRET);
      const now = Math.floor(Date.now() / 1_000);

      expect(typeof payload['iat']).toBe('number');
      expect(typeof payload['exp']).toBe('number');
      expect(Number(payload['exp'])).toBeGreaterThan(now);
      expect(Number(payload['exp'])).toBeLessThanOrEqual(now + MAX_TOKEN_LIFETIME_SECONDS);
    });
  });

  describe('bad credentials', () => {
    it('reject a wrong password', async () => {
      const response = await login({ email: EMAIL, password: WRONG_PASSWORD });

      expect(response.status).toBe(401);
    });

    it('reject an unknown email', async () => {
      const response = await login({ email: UNKNOWN_EMAIL, password: PASSWORD });

      expect(response.status).toBe(401);
    });

    it('reject a password matching only the first 72 bytes of the stored one', async () => {
      // bcrypt truncates at 72 bytes, which would make these two the same credential.
      await register({ email: 'grace@example.com', password: LONG_PASSWORD }).expect(201);

      const response = await login({
        email: 'grace@example.com',
        password: LONG_PASSWORD_SAME_PREFIX,
      });

      expect(response.status).toBe(401);
    });

    it('reject a password that differs only by surrounding whitespace', async () => {
      // Passwords are stored verbatim: nothing trims them on the way in or out.
      const response = await login({ email: EMAIL, password: ` ${PASSWORD} ` });

      expect(response.status).toBe(401);
    });

    it('do not reveal whether the email exists', async () => {
      const wrongPassword = await login({ email: EMAIL, password: WRONG_PASSWORD }).expect(401);
      const unknownEmail = await login({ email: UNKNOWN_EMAIL, password: PASSWORD }).expect(401);

      expect(messageOf(unknownEmail)).toEqual(messageOf(wrongPassword));
    });

    it('do not echo the password back', async () => {
      const response = await login({ email: EMAIL, password: WRONG_PASSWORD }).expect(401);

      expect(JSON.stringify(response.body)).not.toContain(WRONG_PASSWORD);
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
      ['a blank password', { email: EMAIL, password: '' }],
      ['a missing password', { email: EMAIL }],
      ['a missing email', { password: PASSWORD }],
      ['an empty body', {}],
      ['an unrecognised field', { email: EMAIL, password: PASSWORD, role: 'admin' }],
      ['a numeric password', { email: EMAIL, password: 12_345_678 }],
      ['a boolean password', { email: EMAIL, password: true }],
      ['a numeric email', { email: 123, password: PASSWORD }],
      ['an array email', { email: [EMAIL], password: PASSWORD }],
      ['an object password', { email: EMAIL, password: { value: PASSWORD } }],
    ];

    it.each(invalidBodies)('rejects %s with 400', async (_description, body) => {
      const response = await login(body);

      expect(response.status).toBe(400);
    });
  });
});
