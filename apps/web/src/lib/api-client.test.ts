import {
  CURRENT_PASSWORD_MESSAGE,
  DISPLAY_NAME_MESSAGE,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  buildApiUrl,
  changePassword,
  deleteAvatar,
  fetchAvatar,
  getApiBaseUrl,
  getHealth,
  getMe,
  listMeetings,
  login,
  register,
  updateDisplayName,
  uploadAvatar,
} from './api-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A `fetch` that answers every call with one response, and records what it was asked. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getApiBaseUrl', () => {
  it('falls back to the local API when NEXT_PUBLIC_API_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);

    expect(getApiBaseUrl()).toBe('http://localhost:3001/api');
  });

  it('strips trailing slashes from the configured value', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api//');

    expect(getApiBaseUrl()).toBe('https://api.example.com/api');
  });
});

describe('buildApiUrl', () => {
  it('joins a leading-slash path onto the base URL', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');

    expect(buildApiUrl('/health')).toBe('https://api.example.com/api/health');
  });

  it('inserts the missing separator for a bare path', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');

    expect(buildApiUrl('health')).toBe('https://api.example.com/api/health');
  });
});

describe('ApiError', () => {
  it('carries the HTTP status alongside the message', () => {
    const error = new ApiError(503, 'Service unavailable');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(503);
  });
});

describe('register', () => {
  it('posts the credentials as JSON and returns the token', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(jsonResponse(201, { accessToken: 'a-signed-jwt' }));

    await expect(register({ email: 'ada@example.com', password: 'a-password' })).resolves.toEqual({
      accessToken: 'a-signed-jwt',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.example.com/api/auth/register');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ email: 'ada@example.com', password: 'a-password' }));
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('surfaces the API message rather than the status, so a 409 can be shown as-is', async () => {
    stubFetch(
      jsonResponse(409, {
        statusCode: 409,
        message: 'That email is already registered',
        timestamp: '2026-07-30T00:00:00.000Z',
        path: '/api/auth/register',
      }),
    );

    await expect(
      register({ email: 'ada@example.com', password: 'a-password' }),
    ).rejects.toMatchObject({ status: 409, message: 'That email is already registered' });
  });

  it('joins a validation failure into sentences', async () => {
    stubFetch(
      jsonResponse(400, {
        statusCode: 400,
        message: ['email must be an email', 'password must be longer than 7 characters'],
        timestamp: '2026-07-30T00:00:00.000Z',
        path: '/api/auth/register',
      }),
    );

    await expect(register({ email: 'nope', password: 'short' })).rejects.toThrowError(
      'email must be an email. password must be longer than 7 characters.',
    );
  });

  it('falls back to the status when the failure body is not the API error shape', async () => {
    stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    await expect(
      register({ email: 'ada@example.com', password: 'a-password' }),
    ).rejects.toThrowError(/failed with 502/);
  });

  it('falls back to the status when the failure body carries no message', async () => {
    stubFetch(jsonResponse(500, { statusCode: 500 }));

    await expect(
      register({ email: 'ada@example.com', password: 'a-password' }),
    ).rejects.toThrowError(/failed with 500/);
  });
});

describe('login', () => {
  it('posts the credentials as JSON and returns the token', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    // 200, not the 201 register answers with: the endpoint creates nothing.
    const fetchMock = stubFetch(jsonResponse(200, { accessToken: 'a-signed-jwt' }));

    await expect(login({ email: 'ada@example.com', password: 'a-password' })).resolves.toEqual({
      accessToken: 'a-signed-jwt',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.example.com/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ email: 'ada@example.com', password: 'a-password' }));
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('surfaces the 401 message as-is, so the card can show it verbatim', async () => {
    stubFetch(
      jsonResponse(401, {
        statusCode: 401,
        message: 'Invalid email or password',
        timestamp: '2026-07-30T00:00:00.000Z',
        path: '/api/auth/login',
      }),
    );

    await expect(login({ email: 'ada@example.com', password: 'wrong' })).rejects.toMatchObject({
      status: 401,
      message: 'Invalid email or password',
    });
  });

  it('joins a validation failure into sentences', async () => {
    stubFetch(
      jsonResponse(400, {
        statusCode: 400,
        message: ['email must be an email', 'password should not be empty'],
        timestamp: '2026-07-30T00:00:00.000Z',
        path: '/api/auth/login',
      }),
    );

    await expect(login({ email: 'nope', password: '' })).rejects.toThrowError(
      'email must be an email. password should not be empty.',
    );
  });

  it('falls back to the status when the failure body is not the API error shape', async () => {
    stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    await expect(login({ email: 'ada@example.com', password: 'a-password' })).rejects.toThrowError(
      /failed with 502/,
    );
  });
});

describe('getMe', () => {
  it('sends the token as bearer credentials and returns the user', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ada@example.com',
      displayName: 'ada',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const fetchMock = stubFetch(jsonResponse(200, user));

    await expect(getMe('a-signed-jwt')).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.example.com/api/auth/me');
    // The space after `Bearer` is significant: without it the guard rejects the header and the
    // 401 is indistinguishable from an expired token.
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer a-signed-jwt',
    });
  });

  it('rejects with a 401 ApiError, so the caller can tell signed-out from broken', async () => {
    // Nest's bare 401 body: a `message` of "Unauthorized" and nothing a reader could use. The
    // status is the part that matters, and reading this body must not throw.
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(getMe('an-expired-jwt')).rejects.toMatchObject({
      status: 401,
      message: 'Unauthorized',
    });
  });
});

describe('updateDisplayName', () => {
  it('patches /users/me with the name as JSON and returns the updated user', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const updated = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      createdAt: '2026-07-30T00:00:00.000Z',
    };
    const fetchMock = stubFetch(jsonResponse(200, updated));

    await expect(updateDisplayName('a-signed-jwt', 'Ada Lovelace')).resolves.toEqual(updated);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // No user id anywhere in the URL: the endpoint acts on whoever the token names, and one
    // that took an id would be one that could be pointed at somebody else.
    expect(url).toBe('https://api.example.com/api/users/me');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer a-signed-jwt',
    });
    // The whole body, not a subset: an extra field here would be one the DTO's whitelist
    // strips in silence, and the test that only checked `displayName` would not see it.
    expect(JSON.parse(String(init.body))).toEqual({ displayName: 'Ada Lovelace' });
  });

  it('sends the name as typed, leaving the trimming to the API', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'ada@example.com',
        displayName: 'Ada Lovelace',
        createdAt: '2026-07-30T00:00:00.000Z',
      }),
    );

    // The answer carries the trimmed name, which is what the caller stores — so trimming here
    // as well would be a second rule that could one day disagree with the server's.
    await expect(updateDisplayName('a-signed-jwt', '  Ada Lovelace  ')).resolves.toMatchObject({
      displayName: 'Ada Lovelace',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(JSON.parse(String(init.body))).toEqual({ displayName: '  Ada Lovelace  ' });
  });

  it('surfaces the 400 message, which is the sentence the field already shows', async () => {
    stubFetch(jsonResponse(400, { statusCode: 400, message: [DISPLAY_NAME_MESSAGE] }));

    // The edit page puts a 400 under the input rather than above the form, so this message has
    // to be the one the field renders for a name it rejected itself.
    await expect(updateDisplayName('a-signed-jwt', ' ')).rejects.toMatchObject({
      status: 400,
      message: DISPLAY_NAME_MESSAGE,
    });
  });

  it('rejects with a 401 ApiError, so the caller can sign the user out', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(updateDisplayName('an-expired-jwt', 'Ada Lovelace')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('keeps a 500 off the field by leaving it the status message', async () => {
    // Nothing about the name is wrong here, and `describeSaveFailure` tells the two apart by
    // the status alone — so what matters is that a 500 arrives as a 500.
    stubFetch(new Response('upstream exploded', { status: 500 }));

    await expect(updateDisplayName('a-signed-jwt', 'Ada Lovelace')).rejects.toMatchObject({
      status: 500,
    });
  });
});

/** The call every case below varies, so each test states only what it changes about it. */
const change = () => changePassword('a-signed-jwt', 'old-password', 'a-new-password');

describe('changePassword', () => {
  it('patches /auth/password with both passwords and resolves to nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(change()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // No user id and no email: the endpoint acts on whoever the token names, and the current
    // password is what authorises the change.
    expect(url).toBe('https://api.example.com/api/auth/password');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer a-signed-jwt',
    });
    // The whole body: a confirmation field smuggled in here would be one the DTO's whitelist
    // turns into a 400, and a test that only checked the two real fields would not see it.
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: 'old-password',
      newPassword: 'a-new-password',
    });
  });

  it('sends both passwords verbatim, spaces and all', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await changePassword('a-signed-jwt', '  old  ', '  new password  ');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // A password is the bytes the user typed. Trimming one here would store a credential they
    // did not choose, and then refuse the one they did.
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: '  old  ',
      newPassword: '  new password  ',
    });
  });

  it('surfaces the shared sentence for a wrong current password', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: CURRENT_PASSWORD_MESSAGE }));

    // The form tells this 401 from an expired token by this exact message, so the wrapper has
    // to hand it over unchanged rather than flattening it into a status.
    await expect(change()).rejects.toMatchObject({
      status: 401,
      message: CURRENT_PASSWORD_MESSAGE,
    });
  });

  it('leaves a guard 401 carrying its own message', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(change()).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
  });

  it('surfaces the 400 for a new password the API refused', async () => {
    stubFetch(jsonResponse(400, { statusCode: 400, message: PASSWORD_UNCHANGED_MESSAGE }));

    await expect(change()).rejects.toMatchObject({
      status: 400,
      message: PASSWORD_UNCHANGED_MESSAGE,
    });
  });

  it("joins the validation pipe's list into one readable sentence", async () => {
    stubFetch(
      jsonResponse(400, {
        statusCode: 400,
        message: ['newPassword must be longer than or equal to 8 characters'],
      }),
    );

    await expect(change()).rejects.toMatchObject({
      status: 400,
      message: 'newPassword must be longer than or equal to 8 characters.',
    });
  });

  it('keeps a 500 off both fields by leaving it the status', async () => {
    stubFetch(new Response('upstream exploded', { status: 500 }));

    await expect(change()).rejects.toMatchObject({ status: 500 });
  });
});

/** The file every upload case sends. A function, so no two tests share one `File`. */
const picture = () => new File(['bytes'], 'ada.png', { type: 'image/png' });

describe('the avatar endpoints', () => {
  const USER = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    avatarPath: '/users/me/avatar',
    avatarVersion: 4,
    createdAt: '2026-07-30T00:00:00.000Z',
  };

  describe('uploadAvatar', () => {
    it('posts the file as multipart under the field the API reads', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
      const fetchMock = stubFetch(jsonResponse(200, USER));

      await expect(uploadAvatar('a-signed-jwt', picture())).resolves.toEqual(USER);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.example.com/api/users/me/avatar');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('avatar')).toBeInstanceOf(File);
    });

    it('leaves the content type to the browser', async () => {
      const fetchMock = stubFetch(jsonResponse(200, USER));

      await uploadAvatar('a-signed-jwt', picture());

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      // A declared `multipart/form-data` would carry no boundary, and the server could not
      // parse the body — a failure that reads as a broken upload rather than a wrong header.
      expect(init.headers).toEqual({ authorization: 'Bearer a-signed-jwt' });
    });

    it('surfaces the 415 for a type the server refuses', async () => {
      stubFetch(jsonResponse(415, { statusCode: 415, message: 'That is not an image' }));

      await expect(uploadAvatar('a-signed-jwt', picture())).rejects.toMatchObject({ status: 415 });
    });

    it('surfaces the 400 for an image the server cannot decode', async () => {
      stubFetch(jsonResponse(400, { statusCode: 400, message: 'broken' }));

      await expect(uploadAvatar('a-signed-jwt', picture())).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('fetchAvatar', () => {
    it('asks for the bytes with the bearer header and resolves to a blob', async () => {
      vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
      const fetchMock = stubFetch(
        new Response(new Blob(['webp bytes']), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
      );

      const blob = await fetchAvatar('a-signed-jwt');

      expect(blob).toBeInstanceOf(Blob);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      // No `content-type` on the request: this one only reads. The bearer header is the
      // reason an `<img src>` cannot do this job.
      expect(url).toBe('https://api.example.com/api/users/me/avatar');
      expect(init.headers).toEqual({ authorization: 'Bearer a-signed-jwt' });
    });

    it('rejects a 404 as an ApiError, so the caller can fall back to initials', async () => {
      stubFetch(jsonResponse(404, { statusCode: 404, message: 'No avatar' }));

      await expect(fetchAvatar('a-signed-jwt')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('deleteAvatar', () => {
    it('deletes and returns the updated user', async () => {
      const cleared = { ...USER, avatarPath: undefined, avatarVersion: 5 };
      const fetchMock = stubFetch(jsonResponse(200, cleared));

      await expect(deleteAvatar('a-signed-jwt')).resolves.toMatchObject({ avatarVersion: 5 });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(init.method).toBe('DELETE');
      expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
    });

    it('rejects a 401 so the caller can sign the user out', async () => {
      stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

      await expect(deleteAvatar('an-expired-jwt')).rejects.toMatchObject({ status: 401 });
    });
  });
});

describe('listMeetings', () => {
  it('sends the token as bearer credentials and returns the list unchanged', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    // Ascending by `scheduledAt`, the order the endpoint fixes. Nothing at the boundary
    // reorders it — that is `latestMeetings`' job.
    const meetings = [
      {
        id: 'a',
        title: 'Earlier',
        status: 'ended',
        hostId: 'h',
        scheduledAt: '2026-07-01T09:00:00.000Z',
        participantIds: [],
      },
      {
        id: 'b',
        title: 'Later',
        status: 'scheduled',
        hostId: 'h',
        scheduledAt: '2026-08-01T09:00:00.000Z',
        participantIds: [],
      },
    ];
    const fetchMock = stubFetch(jsonResponse(200, meetings));

    await expect(listMeetings('a-signed-jwt')).resolves.toEqual(meetings);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.example.com/api/meetings');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });

  it('returns the empty array a new account gets, rather than treating it as a failure', async () => {
    stubFetch(jsonResponse(200, []));

    await expect(listMeetings('a-signed-jwt')).resolves.toEqual([]);
  });
});

/**
 * The invariant that makes the credential opt-in. If `apiFetch` ever starts reading the token
 * for itself, these are the tests that fail — which is the point: an unauthenticated endpoint
 * receiving a bearer token is a leak, not a convenience.
 */
describe('the unauthenticated endpoints', () => {
  it('sends no authorization header from getHealth', async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, {
        status: 'ok',
        service: 'api',
        timestamp: '2026-07-30T00:00:00.000Z',
        uptimeSeconds: 1,
      }),
    );

    await getHealth();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('sends no authorization header from login', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { accessToken: 'a-signed-jwt' }));

    await login({ email: 'ada@example.com', password: 'a-password' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(init.headers).not.toHaveProperty('authorization');
  });
});
