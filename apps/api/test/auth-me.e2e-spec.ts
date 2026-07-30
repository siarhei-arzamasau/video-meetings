import { EMAIL, ME_URL, PASSWORD, REGISTER_URL, TEST_JWT_SECRET } from './utils/fixtures';
import { accessTokenOf } from './utils/http';
import { signJwtHmac, unsignedJwt } from './utils/jwt';
import { useApiSuite } from './utils/api-suite';
import { deleteUser, findUserRow } from './utils/users-table';

/**
 * The authorisation half: proving the token issued by register and login actually grants
 * access, and — more importantly — that forged, expired, and stale ones do not.
 */
describe(`GET ${ME_URL}`, () => {
  const suite = useApiSuite();

  let token: string;
  let userId: string;

  const authorised = (bearer: string) => suite.get(ME_URL).set('Authorization', bearer);

  beforeEach(async () => {
    const response = await suite
      .post(REGISTER_URL, { email: EMAIL, password: PASSWORD })
      .expect(201);

    token = accessTokenOf(response);
    userId = (await findUserRow(suite.prisma(), EMAIL)).id;
  });

  describe('with a valid token', () => {
    it('returns the current user', async () => {
      const response = await authorised(`Bearer ${token}`).expect(200);
      const row = await findUserRow(suite.prisma(), EMAIL);
      const body = response.body as Record<string, unknown>;

      expect(body['id']).toBe(userId);
      expect(body['email']).toBe(EMAIL);
      expect(body['displayName']).toBe('ada');
      expect(body['createdAt']).toBe(row.created_at.toISOString());
    });

    it('returns exactly the public user fields', async () => {
      const response = await authorised(`Bearer ${token}`).expect(200);

      expect(Object.keys(response.body as object).toSorted()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
      ]);
    });

    it('never exposes the stored hash', async () => {
      const row = await findUserRow(suite.prisma(), EMAIL);

      const response = await authorised(`Bearer ${token}`).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain(row.password_hash);
      expect(serialised).not.toContain(PASSWORD);
    });
  });

  describe('without a usable token', () => {
    it('rejects a request with no Authorization header', async () => {
      await suite.get(ME_URL).expect(401);
    });

    it.each([
      ['a token that is not a JWT', () => 'Bearer not-a-jwt'],
      ['an empty bearer value', () => 'Bearer '],
      ['a bare token with no scheme', () => token],
      ['the wrong scheme', () => `Basic ${token}`],
    ])('rejects %s', async (_description, header) => {
      await authorised(header()).expect(401);
    });
  });

  describe('with a forged or stale token', () => {
    it('rejects a token signed with a different secret', async () => {
      const forged = signJwtHmac({ sub: userId, ...validityWindow() }, 'some-other-secret');

      await authorised(`Bearer ${forged}`).expect(401);
    });

    it('rejects an unsigned alg:none token naming a real user', async () => {
      // If the verifier trusts the header's `alg`, this hands the caller any account.
      const forged = unsignedJwt({ sub: userId, ...validityWindow() });

      await authorised(`Bearer ${forged}`).expect(401);
    });

    it('rejects a token signed with HS512 instead of HS256', async () => {
      const forged = signJwtHmac({ sub: userId, ...validityWindow() }, TEST_JWT_SECRET, 'HS512');

      await authorised(`Bearer ${forged}`).expect(401);
    });

    it('rejects an expired token', async () => {
      const issuedAt = Math.floor(Date.now() / 1_000) - 7_200;
      const expired = signJwtHmac(
        { sub: userId, iat: issuedAt, exp: issuedAt + 3_600 },
        TEST_JWT_SECRET,
      );

      await authorised(`Bearer ${expired}`).expect(401);
    });

    it('rejects a valid token whose subject no longer exists', async () => {
      await deleteUser(suite.prisma(), EMAIL);

      await authorised(`Bearer ${token}`).expect(401);
    });
  });
});

function validityWindow(): { iat: number; exp: number } {
  const now = Math.floor(Date.now() / 1_000);

  return { iat: now, exp: now + 3_600 };
}
