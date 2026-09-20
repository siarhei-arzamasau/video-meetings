import { describeImage, imageOf, oversizedImage, undecodablePng } from './utils/avatar-images';
import { useApiSuite } from './utils/api-suite';
import {
  AVATAR_CONTENT_TYPE,
  AVATAR_EMPTY_MESSAGE,
  AVATAR_SIZE_MESSAGE,
  AVATAR_SIZE_PIXELS,
  AVATAR_TYPE_MESSAGE,
  AVATAR_UNREADABLE_MESSAGE,
  AVATAR_URL,
  EMAIL,
  MAX_AVATAR_SIZE_BYTES,
  ME_URL,
  OTHER_EMAIL,
  PASSWORD,
  REGISTER_URL,
} from './utils/fixtures';
import { accessTokenOf, messageOf } from './utils/http';
import { signJwtHmac } from './utils/jwt';
import { deleteUser, findUserRow, readUserSnapshot } from './utils/users-table';

/**
 * The avatar, end to end: upload, fetch, remove.
 *
 * Two claims run through nearly every test here. **Every avatar the API serves is the same
 * square**, whatever arrived — so the fetched bytes are decoded and measured rather than
 * merely counted. And **a rejected upload changes nothing**, so each refusal is asserted
 * against what is still served afterwards, not only against the status.
 */
describe(`${AVATAR_URL}`, () => {
  const suite = useApiSuite();

  const registerUser = async (email: string): Promise<{ id: string; token: string }> => {
    const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
    const user = await findUserRow(suite.prisma(), email);

    return { id: user.id, token: accessTokenOf(response) };
  };

  const upload = (token: string, bytes: Buffer, filename = 'avatar.png') =>
    suite.postFile(AVATAR_URL, token, bytes, { fieldName: 'avatar', filename });

  const fetchAvatar = (token: string) =>
    suite.get(AVATAR_URL).set('Authorization', `Bearer ${token}`);

  const removeAvatar = (token: string) =>
    suite.delete(AVATAR_URL).set('Authorization', `Bearer ${token}`);

  const me = (token: string) => suite.get(ME_URL).set('Authorization', `Bearer ${token}`);

  const storedKey = async (email: string): Promise<unknown> =>
    (await readUserSnapshot(suite.prisma(), email))['avatar_key'];

  const storedVersion = async (email: string): Promise<unknown> =>
    (await readUserSnapshot(suite.prisma(), email))['avatar_version'];

  describe('uploading', () => {
    it.each([
      ['a PNG', 'png' as const],
      ['a JPEG', 'jpeg' as const],
      ['a WebP', 'webp' as const],
    ])('accepts %s and answers with the updated user', async (_description, format) => {
      const { token } = await registerUser(EMAIL);

      const response = await upload(token, await imageOf(300, 300, format)).expect(200);
      const body = response.body as Record<string, unknown>;

      expect(body['avatarPath']).toBe('/users/me/avatar');
      expect(body['avatarVersion']).toBe(1);
      expect(body['email']).toBe(EMAIL);
    });

    it.each([
      ['a wide image', 800, 200],
      ['a tall image', 200, 800],
      ['a square image', 512, 512],
      ['an image smaller than the rendition', 64, 40],
    ])('serves %s back as the one agreed square', async (_description, width, height) => {
      const { token } = await registerUser(EMAIL);

      await upload(token, await imageOf(width, height, 'png')).expect(200);

      const served = await fetchAvatar(token).expect(200);

      // The acceptance criterion, asserted on the bytes rather than on the request: every
      // avatar the app draws is the same square whatever was uploaded.
      await expect(describeImage(served.body as Buffer)).resolves.toEqual({
        width: AVATAR_SIZE_PIXELS,
        height: AVATAR_SIZE_PIXELS,
        format: 'webp',
      });
    });

    it('serves it as an inline WebP the browser may not second-guess', async () => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      const served = await fetchAvatar(token).expect(200);

      expect(served.headers['content-type']).toContain(AVATAR_CONTENT_TYPE);
      expect(served.headers['content-disposition']).toBe('inline');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      // The path never changes, so a cached response would be an old picture the browser had
      // no reason to re-request. `avatarVersion` is what tells a client to fetch again.
      expect(served.headers['cache-control']).toBe('private, no-store');
    });

    it('is what GET /auth/me reports afterwards', async () => {
      const { token } = await registerUser(EMAIL);

      const before = await me(token).expect(200);

      expect((before.body as Record<string, unknown>)['avatarPath']).toBeUndefined();
      expect((before.body as Record<string, unknown>)['avatarVersion']).toBe(0);

      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      const after = await me(token).expect(200);

      expect((after.body as Record<string, unknown>)['avatarPath']).toBe('/users/me/avatar');
      expect((after.body as Record<string, unknown>)['avatarVersion']).toBe(1);
    });

    it('replaces the previous picture and bumps the version each time', async () => {
      const { token } = await registerUser(EMAIL);

      await upload(token, await imageOf(300, 300, 'png')).expect(200);
      const first = (await fetchAvatar(token).expect(200)).body as Buffer;

      const second = await upload(
        token,
        await imageOf(400, 100, 'jpeg', { r: 220, g: 40, b: 40 }),
      ).expect(200);

      expect((second.body as Record<string, unknown>)['avatarVersion']).toBe(2);
      // One object per user, replaced in place — so the old bytes are not merely unreferenced,
      // they are gone.
      expect(((await fetchAvatar(token).expect(200)).body as Buffer).equals(first)).toBe(false);
    });

    it('never puts the storage key in the response', async () => {
      const { token } = await registerUser(EMAIL);
      const { id } = await findUserRow(suite.prisma(), EMAIL);

      const response = await upload(token, await imageOf(300, 300, 'png')).expect(200);

      // The key is a path on the server's disk. What crosses is the route that serves it.
      expect(JSON.stringify(response.body)).not.toContain(`${id}.webp`);
      expect(Object.keys(response.body as object).toSorted()).toEqual([
        'avatarPath',
        'avatarVersion',
        'createdAt',
        'displayName',
        'email',
        'id',
      ]);
    });

    it('changes nothing else about the row', async () => {
      const { token } = await registerUser(EMAIL);
      const before = await readUserSnapshot(suite.prisma(), EMAIL);

      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      const after = await readUserSnapshot(suite.prisma(), EMAIL);

      expect(after).toEqual({
        ...before,
        avatar_key: after['avatar_key'],
        avatar_version: 1,
      });
    });
  });

  describe('refusing an upload, with the previous picture untouched', () => {
    /** An account that already has an avatar, so a refusal has something to preserve. */
    const withAvatar = async (): Promise<{ token: string; bytes: Buffer }> => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      return { token, bytes: (await fetchAvatar(token).expect(200)).body as Buffer };
    };

    const expectUnchanged = async (token: string, bytes: Buffer): Promise<void> => {
      expect(((await fetchAvatar(token).expect(200)).body as Buffer).equals(bytes)).toBe(true);
      expect(await storedVersion(EMAIL)).toBe(1);
    };

    it('rejects a file over the cap with the shared sentence', async () => {
      const { token, bytes } = await withAvatar();

      const response = await upload(
        token,
        await oversizedImage(MAX_AVATAR_SIZE_BYTES),
        'huge.png',
      ).expect(413);

      expect(messageOf(response)).toBe(AVATAR_SIZE_MESSAGE);
      await expectUnchanged(token, bytes);
    });

    it('rejects an empty file with its own sentence', async () => {
      const { token, bytes } = await withAvatar();

      const response = await upload(token, Buffer.alloc(0), 'empty.png').expect(400);

      // Not "could not be read": that would send the user looking for a damaged image.
      expect(messageOf(response)).toBe(AVATAR_EMPTY_MESSAGE);
      await expectUnchanged(token, bytes);
    });

    it('rejects a real image of a type the contract does not take', async () => {
      const { token, bytes } = await withAvatar();

      const response = await upload(token, await imageOf(200, 200, 'gif'), 'animated.gif').expect(
        415,
      );

      expect(messageOf(response)).toBe(AVATAR_TYPE_MESSAGE);
      await expectUnchanged(token, bytes);
    });

    it('rejects a file that is not an image at all, whatever it is called', async () => {
      const { token, bytes } = await withAvatar();

      // Decoding is the check, so the extension never gets a vote.
      const response = await upload(token, Buffer.from('not a picture'), 'photo.png').expect(400);

      expect(messageOf(response)).toBe(AVATAR_UNREADABLE_MESSAGE);
      await expectUnchanged(token, bytes);
    });

    it('rejects a PNG whose header parses and whose pixels do not', async () => {
      const { token, bytes } = await withAvatar();

      const response = await upload(token, await undecodablePng(), 'broken.png').expect(400);

      expect(messageOf(response)).toBe(AVATAR_UNREADABLE_MESSAGE);
      await expectUnchanged(token, bytes);
    });

    it('rejects a request with no file part', async () => {
      const { token } = await registerUser(EMAIL);

      await suite.post(AVATAR_URL, {}).set('Authorization', `Bearer ${token}`).expect(400);

      expect(await storedKey(EMAIL)).toBeNull();
    });

    it('rejects a file sent under the wrong field name', async () => {
      const { token } = await registerUser(EMAIL);

      await suite
        .postFile(AVATAR_URL, token, await imageOf(300, 300, 'png'), { fieldName: 'file' })
        .expect(400);

      expect(await storedKey(EMAIL)).toBeNull();
    });
  });

  describe('fetching', () => {
    it('answers 404 for an account that has never had one', async () => {
      const { token } = await registerUser(EMAIL);

      await fetchAvatar(token).expect(404);
    });

    it('answers 404 after removal, so the previous URL stops working', async () => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);
      await fetchAvatar(token).expect(200);

      await removeAvatar(token).expect(200);

      await fetchAvatar(token).expect(404);
    });
  });

  describe('removing', () => {
    it('clears the reference, bumps the version, and answers with the user', async () => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      const response = await removeAvatar(token).expect(200);
      const body = response.body as Record<string, unknown>;

      expect(body['avatarPath']).toBeUndefined();
      expect(body['avatarVersion']).toBe(2);
      expect(await storedKey(EMAIL)).toBeNull();
    });

    it('is a no-op on an account that has none, rather than a 404', async () => {
      const { token } = await registerUser(EMAIL);

      const response = await removeAvatar(token).expect(200);

      // The state asked for is the state it is already in. The version stays put, so no
      // client re-fetches an image that did not change.
      expect((response.body as Record<string, unknown>)['avatarVersion']).toBe(0);
    });

    it('can be repeated without moving the version again', async () => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);

      await removeAvatar(token).expect(200);
      const second = await removeAvatar(token).expect(200);

      expect((second.body as Record<string, unknown>)['avatarVersion']).toBe(2);
    });

    it('lets the account upload a new picture afterwards', async () => {
      const { token } = await registerUser(EMAIL);
      await upload(token, await imageOf(300, 300, 'png')).expect(200);
      await removeAvatar(token).expect(200);

      const response = await upload(token, await imageOf(300, 300, 'webp')).expect(200);

      expect((response.body as Record<string, unknown>)['avatarVersion']).toBe(3);
      await fetchAvatar(token).expect(200);
    });
  });

  describe('taking the caller from the token and nowhere else', () => {
    it('has no sibling route that takes a user id', async () => {
      const { id, token } = await registerUser(EMAIL);

      await suite
        .get(`/api/users/${id}/avatar`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it("one user cannot read another's picture", async () => {
      const ada = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      await upload(ada.token, await imageOf(300, 300, 'png')).expect(200);

      // Grace's token on the `me` route reaches Grace's avatar, which does not exist. There
      // is no route that would reach Ada's.
      await fetchAvatar(grace.token).expect(404);
    });

    it("one user cannot replace or remove another's picture", async () => {
      const ada = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);
      await upload(ada.token, await imageOf(300, 300, 'png')).expect(200);
      const adaBytes = (await fetchAvatar(ada.token).expect(200)).body as Buffer;

      await upload(grace.token, await imageOf(100, 400, 'jpeg')).expect(200);
      await removeAvatar(grace.token).expect(200);

      expect(((await fetchAvatar(ada.token).expect(200)).body as Buffer).equals(adaBytes)).toBe(
        true,
      );
      expect(await storedVersion(EMAIL)).toBe(1);
    });

    it('stores each account under its own object', async () => {
      const ada = await registerUser(EMAIL);
      const grace = await registerUser(OTHER_EMAIL);

      await upload(ada.token, await imageOf(600, 200, 'png')).expect(200);
      await upload(grace.token, await imageOf(200, 600, 'png', { r: 240, g: 240, b: 20 })).expect(
        200,
      );

      const adaBytes = (await fetchAvatar(ada.token).expect(200)).body as Buffer;
      const graceBytes = (await fetchAvatar(grace.token).expect(200)).body as Buffer;

      // Same dimensions, different pictures: the rendition is shared, the object is not.
      expect(adaBytes.equals(graceBytes)).toBe(false);
      await expect(describeImage(graceBytes)).resolves.toMatchObject({
        width: AVATAR_SIZE_PIXELS,
        height: AVATAR_SIZE_PIXELS,
      });
    });
  });

  describe('without a usable token', () => {
    it.each([
      ['uploading', (token: string) => upload(token, Buffer.from('x'), 'a.png')],
      ['fetching', (token: string) => fetchAvatar(token)],
      ['removing', (token: string) => removeAvatar(token)],
    ])('rejects %s with no Authorization header', async (_description, request) => {
      await registerUser(EMAIL);

      await request('').expect(401);

      expect(await storedKey(EMAIL)).toBeNull();
    });

    it('rejects a token signed with a different secret', async () => {
      const { id } = await registerUser(EMAIL);
      const now = Math.floor(Date.now() / 1_000);
      const forged = signJwtHmac({ sub: id, iat: now, exp: now + 3_600 }, 'some-other-secret');

      await upload(forged, await imageOf(300, 300, 'png')).expect(401);

      expect(await storedKey(EMAIL)).toBeNull();
    });

    it('rejects a valid token whose subject was deleted mid-session', async () => {
      const { token } = await registerUser(EMAIL);

      await deleteUser(suite.prisma(), EMAIL);

      await upload(token, await imageOf(300, 300, 'png')).expect(401);
      await fetchAvatar(token).expect(401);
      await removeAvatar(token).expect(401);
    });
  });
});
