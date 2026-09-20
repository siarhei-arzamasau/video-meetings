import { useApiSuite } from './utils/api-suite';
import {
  DISPLAY_NAME_MESSAGE,
  EMAIL,
  MAX_DISPLAY_NAME_LENGTH,
  ME_URL,
  OTHER_EMAIL,
  PASSWORD,
  REGISTER_URL,
  USERS_ME_URL,
} from './utils/fixtures';
import { accessTokenOf, messageOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import { deleteUser, findUserRow, readUserSnapshot } from './utils/users-table';

/**
 * The display name is the first thing about a user the user owns. Registration still derives
 * it from the address, so what these specs are really pinning down is the handover: a name
 * the caller set survives, and nothing but that caller can move it.
 *
 * Every rejection is asserted twice — the status and message the browser will show, and the
 * stored row afterwards. A 400 that also wrote is not a rejection.
 */
describe(`PATCH ${USERS_ME_URL}`, () => {
  const suite = useApiSuite();

  const registerUser = async (email: string): Promise<{ id: string; token: string }> => {
    const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
    const user = await findUserRow(suite.prisma(), email);

    return { id: user.id, token: accessTokenOf(response) };
  };

  const rename = (token: string, body: object) =>
    suite.patch(USERS_ME_URL, body).set('Authorization', `Bearer ${token}`);

  const storedName = async (email: string): Promise<unknown> =>
    (await readUserSnapshot(suite.prisma(), email))['display_name'];

  describe('with a valid token', () => {
    it('saves the new name and reports it back as the whole user', async () => {
      const { id, token } = await registerUser(EMAIL);

      const response = await rename(token, { displayName: 'Ada Lovelace' }).expect(200);
      const body = response.body as Record<string, unknown>;

      expect(body['displayName']).toBe('Ada Lovelace');
      expect(body['id']).toBe(id);
      expect(body['email']).toBe(EMAIL);
      expect(await storedName(EMAIL)).toBe('Ada Lovelace');
    });

    it(`is what ${ME_URL} returns afterwards`, async () => {
      const { token } = await registerUser(EMAIL);

      // Registration derives the name from the address; this is the value being replaced.
      const before = await suite.get(ME_URL).set('Authorization', `Bearer ${token}`).expect(200);

      expect((before.body as Record<string, unknown>)['displayName']).toBe('ada');

      await rename(token, { displayName: 'Ada Lovelace' }).expect(200);

      const after = await suite.get(ME_URL).set('Authorization', `Bearer ${token}`).expect(200);

      expect((after.body as Record<string, unknown>)['displayName']).toBe('Ada Lovelace');
    });

    it('answers with exactly the public user fields, and never the stored hash', async () => {
      const { token } = await registerUser(EMAIL);
      const row = await findUserRow(suite.prisma(), EMAIL);

      const response = await rename(token, { displayName: 'Ada Lovelace' }).expect(200);

      expect(Object.keys(response.body as object).toSorted()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
      ]);
      expect(JSON.stringify(response.body)).not.toContain(row.password_hash);
    });

    it('stores the trimmed name, not what was sent', async () => {
      const { token } = await registerUser(EMAIL);

      const response = await rename(token, { displayName: '   Ada Lovelace   ' }).expect(200);

      expect((response.body as Record<string, unknown>)['displayName']).toBe('Ada Lovelace');
      expect(await storedName(EMAIL)).toBe('Ada Lovelace');
    });

    it('accepts a name of exactly the maximum length', async () => {
      const { token } = await registerUser(EMAIL);
      const name = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);

      await rename(token, { displayName: name }).expect(200);

      expect(await storedName(EMAIL)).toBe(name);
    });

    it('accepts a name of exactly the maximum length once its padding is trimmed', async () => {
      // The regression trim-then-measure exists for: measure-then-trim rejects this.
      const { token } = await registerUser(EMAIL);
      const name = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);

      await rename(token, { displayName: `  ${name}  ` }).expect(200);

      expect(await storedName(EMAIL)).toBe(name);
    });

    it('changes nothing else about the row', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      await rename(token, { displayName: 'Ada Lovelace' }).expect(200);

      const after = await readUserSnapshot(suite.prisma(), EMAIL);

      expect(after).toEqual({ ...before, display_name: 'Ada Lovelace' });
    });
  });

  describe('rejecting a name the bounds do not allow', () => {
    it.each([
      ['a blank name', ''],
      ['a whitespace-only name', '     '],
      ['a tab-and-newline-only name', '\t\n '],
      ['a name one character over the maximum', 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)],
    ])('rejects %s with the shared message, and stores nothing', async (_description, value) => {
      const { token } = await registerUser(EMAIL);
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      const response = await rename(token, { displayName: value }).expect(400);

      expect(messageOf(response)).toEqual([DISPLAY_NAME_MESSAGE]);
      expect(await readUserSnapshot(suite.prisma(), EMAIL)).toEqual(before);
    });

    it.each([
      ['a missing field', {}],
      ['a null name', { displayName: null }],
      ['a numeric name', { displayName: 42 }],
      ['an array of names', { displayName: ['Ada'] }],
    ])('rejects %s, and stores nothing', async (_description, body) => {
      const { token } = await registerUser(EMAIL);
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      await rename(token, body).expect(400);

      expect(await readUserSnapshot(suite.prisma(), EMAIL)).toEqual(before);
    });

    it('reports the bounds once, not once per bound', async () => {
      // Paired @MinLength/@MaxLength both fail on a value that is not a string, and both
      // carried this message — the response said the same sentence twice.
      const { token } = await registerUser(EMAIL);

      const response = await rename(token, { displayName: 42 }).expect(400);
      const messages = messagesOf(response);

      expect(messages).toContain(DISPLAY_NAME_MESSAGE);
      expect(messages.filter((message) => message === DISPLAY_NAME_MESSAGE)).toHaveLength(1);
    });
  });

  describe('taking the caller from the token and nowhere else', () => {
    it('has no sibling route that takes a user id', async () => {
      const { id, token } = await registerUser(EMAIL);

      // Not 200, not 403 — the route does not exist. That is the rule enforced structurally
      // rather than by a check every future handler has to remember.
      await suite
        .patch(`/api/users/${id}`, { displayName: 'Ada Lovelace' })
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('rejects a body that names another user id rather than silently dropping it', async () => {
      const { token } = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);

      const response = await rename(token, {
        displayName: 'Ada Lovelace',
        id: grace.id,
      }).expect(400);

      expect(messageOf(response)).toContain('property id should not exist');
      expect(await storedName(EMAIL)).toBe('ada');
      expect(await storedName(OTHER_EMAIL)).toBe('grace');
    });

    it('renames only the caller when two users are signed in', async () => {
      await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);

      await rename(grace.token, { displayName: 'Grace Hopper' }).expect(200);

      expect(await storedName(OTHER_EMAIL)).toBe('Grace Hopper');
      expect(await storedName(EMAIL)).toBe('ada');
    });
  });

  describe('without a usable token', () => {
    it('rejects a request with no Authorization header, and stores nothing', async () => {
      await registerUser(EMAIL);

      await suite.patch(USERS_ME_URL, { displayName: 'Ada Lovelace' }).expect(401);

      expect(await storedName(EMAIL)).toBe('ada');
    });

    it.each([
      ['a token that is not a JWT', 'not-a-jwt'],
      ['an empty bearer value', ''],
    ])('rejects %s, and stores nothing', async (_description, value) => {
      await registerUser(EMAIL);

      await rename(value, { displayName: 'Ada Lovelace' }).expect(401);

      expect(await storedName(EMAIL)).toBe('ada');
    });

    it('rejects a token signed with a different secret', async () => {
      const { id } = await registerUser(EMAIL);
      const now = Math.floor(Date.now() / 1_000);
      const forged = signJwtHmac({ sub: id, iat: now, exp: now + 3_600 }, 'some-other-secret');

      await rename(forged, { displayName: 'Ada Lovelace' }).expect(401);

      expect(await storedName(EMAIL)).toBe('ada');
    });

    it('rejects a valid token whose subject was deleted mid-session', async () => {
      // The guard answers first. The handler's own P2025 path is the narrower race behind it:
      // a row that disappears between the guard's read and the update.
      const { token } = await registerUser(EMAIL);

      await deleteUser(suite.prisma(), EMAIL);

      await rename(token, { displayName: 'Ada Lovelace' }).expect(401);
    });
  });
});

/** `messageOf` answers a string or an array; a validation failure is always the array. */
function messagesOf(response: { body: unknown }): string[] {
  const message = messageOf(response as Parameters<typeof messageOf>[0]);

  if (!Array.isArray(message)) {
    throw new Error(`Expected a list of validation messages, received ${JSON.stringify(message)}`);
  }

  return message;
}
