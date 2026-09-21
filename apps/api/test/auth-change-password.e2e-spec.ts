import { useApiSuite } from './utils/api-suite';
import {
  CHANGE_PASSWORD_URL,
  CURRENT_PASSWORD_MESSAGE,
  EMAIL,
  LOGIN_URL,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  NEW_PASSWORD,
  OTHER_EMAIL,
  PASSWORD,
  PASSWORD_UNCHANGED_MESSAGE,
  REGISTER_URL,
} from './utils/fixtures';
import { accessTokenOf, messageOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import { deleteUser, findUserRow, readUserSnapshot } from './utils/users-table';

/**
 * Rotating a password is the one change in this app that can lock its owner out, so every
 * test here asserts two things: what the caller is told, and what the stored hash is
 * afterwards. A 401 that also wrote would be the worst outcome the endpoint has, and the
 * response alone could never show it.
 *
 * The rotation itself is asserted through `login`, not through the column: what matters is
 * that the old password stops working and the new one starts, and only login can say that.
 */
describe(`PATCH ${CHANGE_PASSWORD_URL}`, () => {
  const suite = useApiSuite();

  const registerUser = async (email: string): Promise<{ id: string; token: string }> => {
    const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
    const user = await findUserRow(suite.prisma(), email);

    return { id: user.id, token: accessTokenOf(response) };
  };

  const changePassword = (token: string, body: object) =>
    suite.patch(CHANGE_PASSWORD_URL, body).set('Authorization', `Bearer ${token}`);

  const storedHash = async (email: string): Promise<string> =>
    (await findUserRow(suite.prisma(), email)).password_hash;

  const login = (email: string, password: string) => suite.post(LOGIN_URL, { email, password });

  describe('with the correct current password', () => {
    it('answers 204 with no body and leaves nothing to parse', async () => {
      const { token } = await registerUser(EMAIL);

      const response = await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      expect(response.text).toBe('');
    });

    it('makes the old password stop working and the new one start', async () => {
      const { token } = await registerUser(EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      await login(EMAIL, PASSWORD).expect(401);
      const signedIn = await login(EMAIL, NEW_PASSWORD).expect(200);

      expect(accessTokenOf(signedIn)).toBeTruthy();
    });

    it('stores a new argon2id hash rather than the password', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      const after = await storedHash(EMAIL);

      expect(after).not.toBe(before);
      expect(after.startsWith('$argon2id$')).toBe(true);
      expect(after).not.toContain(NEW_PASSWORD);
    });

    it('changes nothing else about the row', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      const after = await readUserSnapshot(suite.prisma(), EMAIL);

      expect(after).toEqual({ ...before, password_hash: after['password_hash'] });
      expect(after['password_hash']).not.toBe(before['password_hash']);
    });

    it('leaves the token that made the change working', async () => {
      // A stateless JWT carries no password, so it survives the rotation — the property the
      // edit page states in words next to the form. Asserted so that a future revocation
      // list has to change this test on purpose.
      const { token } = await registerUser(EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      await suite.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    });

    it('can be done twice in a row, each time against the password then in force', async () => {
      const { token } = await registerUser(EMAIL);
      const third = 'third-battery-44-and-more';

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);
      await changePassword(token, {
        currentPassword: NEW_PASSWORD,
        newPassword: third,
      }).expect(204);

      await login(EMAIL, NEW_PASSWORD).expect(401);
      await login(EMAIL, third).expect(200);
    });

    it.each([
      ['the minimum length', 'x'.repeat(MIN_PASSWORD_LENGTH)],
      ['the maximum length', 'x'.repeat(MAX_PASSWORD_LENGTH)],
    ])('accepts a new password of exactly %s', async (_description, newPassword) => {
      const { token } = await registerUser(EMAIL);

      await changePassword(token, { currentPassword: PASSWORD, newPassword }).expect(204);

      await login(EMAIL, newPassword).expect(200);
    });
  });

  describe('rejecting the change with the hash untouched', () => {
    it('answers a wrong current password with a 401 and the shared sentence', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      const response = await changePassword(token, {
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
      }).expect(401);

      expect(messageOf(response)).toBe(CURRENT_PASSWORD_MESSAGE);
      expect(await storedHash(EMAIL)).toBe(before);
      await login(EMAIL, PASSWORD).expect(200);
    });

    it('says nothing about the account beyond that one sentence', async () => {
      // The same discipline login has: the response must not confirm a guess, name the
      // address, or say how many attempts are left.
      const { token } = await registerUser(EMAIL);

      const response = await changePassword(token, {
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
      }).expect(401);

      const body = JSON.stringify(response.body);

      expect(body).not.toContain(EMAIL);
      expect(body).not.toContain(PASSWORD);
      expect(body).not.toContain('argon2');
    });

    it('answers a new password equal to the current one with a 400', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      const response = await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      }).expect(400);

      expect(messageOf(response)).toBe(PASSWORD_UNCHANGED_MESSAGE);
      expect(await storedHash(EMAIL)).toBe(before);
    });

    it('reports a wrong current password even when the new one is also unchanged', async () => {
      // Order matters: answering "unchanged" first would tell someone holding a stolen token
      // whether a guess is the account's current password.
      const { token } = await registerUser(EMAIL);

      const response = await changePassword(token, {
        currentPassword: 'a-guess-that-is-wrong',
        newPassword: 'a-guess-that-is-wrong',
      }).expect(401);

      expect(messageOf(response)).toBe(CURRENT_PASSWORD_MESSAGE);
    });

    it.each([
      ['one character under the minimum', 'x'.repeat(MIN_PASSWORD_LENGTH - 1)],
      ['one character over the maximum', 'x'.repeat(MAX_PASSWORD_LENGTH + 1)],
      ['blank', ''],
      ['nothing but spaces', '          '],
    ])('rejects a new password that is %s with a 400', async (_description, newPassword) => {
      const { token } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      await changePassword(token, { currentPassword: PASSWORD, newPassword }).expect(400);

      expect(await storedHash(EMAIL)).toBe(before);
      await login(EMAIL, PASSWORD).expect(200);
    });

    it.each([
      ['a missing current password', { newPassword: NEW_PASSWORD }],
      ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }],
      ['a missing new password', { currentPassword: PASSWORD }],
      ['a numeric new password', { currentPassword: PASSWORD, newPassword: 12_345_678 }],
      ['a null new password', { currentPassword: PASSWORD, newPassword: null }],
    ])('rejects %s with a 400, and stores nothing', async (_description, body) => {
      const { token } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      await changePassword(token, body).expect(400);

      expect(await storedHash(EMAIL)).toBe(before);
    });

    it('rejects a body that names a user rather than silently dropping the field', async () => {
      const { token } = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      const before = await storedHash(OTHER_EMAIL);

      const response = await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        userId: grace.id,
      }).expect(400);

      expect(messageOf(response)).toContain('property userId should not exist');
      expect(await storedHash(OTHER_EMAIL)).toBe(before);
    });
  });

  describe('taking the caller from the token and nowhere else', () => {
    it('changes only the caller when two accounts exist', async () => {
      const { token } = await registerUser(EMAIL);
      await registerUser(OTHER_EMAIL);
      const graceBefore = await storedHash(OTHER_EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(204);

      expect(await storedHash(OTHER_EMAIL)).toBe(graceBefore);
      await login(OTHER_EMAIL, PASSWORD).expect(200);
      await login(OTHER_EMAIL, NEW_PASSWORD).expect(401);
    });

    it("cannot be pointed at another account by knowing that account's password", async () => {
      // Grace's token plus Ada's password must reach nothing: the caller is the token's
      // subject, so the current password offered is checked against Grace's hash and fails.
      await registerUser(EMAIL);
      const graceToken = accessTokenOf(
        await suite.post(REGISTER_URL, { email: OTHER_EMAIL, password: NEW_PASSWORD }).expect(201),
      );
      const adaBefore = await storedHash(EMAIL);

      await changePassword(graceToken, {
        currentPassword: PASSWORD,
        newPassword: 'something-else-entirely',
      }).expect(401);

      expect(await storedHash(EMAIL)).toBe(adaBefore);
      await login(EMAIL, PASSWORD).expect(200);
      await login(OTHER_EMAIL, NEW_PASSWORD).expect(200);
    });

    it('has no sibling route that takes a user id', async () => {
      const { id, token } = await registerUser(EMAIL);

      await suite
        .patch(`/api/auth/${id}/password`, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  describe('without a usable token', () => {
    it('rejects a request with no Authorization header, and stores nothing', async () => {
      await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      await suite
        .patch(CHANGE_PASSWORD_URL, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);

      expect(await storedHash(EMAIL)).toBe(before);
      await login(EMAIL, PASSWORD).expect(200);
    });

    it.each([
      ['a token that is not a JWT', 'not-a-jwt'],
      ['an empty bearer value', ''],
    ])('rejects %s, and stores nothing', async (_description, value) => {
      await registerUser(EMAIL);
      const before = await storedHash(EMAIL);

      await changePassword(value, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(401);

      expect(await storedHash(EMAIL)).toBe(before);
    });

    it('rejects a token signed with a different secret', async () => {
      const { id } = await registerUser(EMAIL);
      const before = await storedHash(EMAIL);
      const now = Math.floor(Date.now() / 1_000);
      const forged = signJwtHmac({ sub: id, iat: now, exp: now + 3_600 }, 'some-other-secret');

      await changePassword(forged, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(401);

      expect(await storedHash(EMAIL)).toBe(before);
    });

    it('rejects a valid token whose subject was deleted mid-session', async () => {
      const { token } = await registerUser(EMAIL);

      await deleteUser(suite.prisma(), EMAIL);

      await changePassword(token, {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      }).expect(401);
    });

    it('answers a guard 401 with a different message from a wrong password', async () => {
      // The browser tells "sign out" from "wrong password" by this sentence alone, because
      // both are 401s on the same route. If they ever converge, a typo signs the user out.
      await registerUser(EMAIL);

      const guard = await suite
        .patch(CHANGE_PASSWORD_URL, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);

      expect(messageOf(guard)).not.toBe(CURRENT_PASSWORD_MESSAGE);
    });
  });
});
