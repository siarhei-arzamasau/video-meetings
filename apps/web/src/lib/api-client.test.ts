import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  buildApiUrl,
  getApiBaseUrl,
  getHealth,
  getMe,
  listMeetings,
  login,
  register,
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
