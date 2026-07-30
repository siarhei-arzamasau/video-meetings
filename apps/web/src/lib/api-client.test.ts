import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, buildApiUrl, getApiBaseUrl, register } from './api-client';

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
