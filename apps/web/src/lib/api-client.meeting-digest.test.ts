import type { MeetingDigest } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMeetingDigest, requestMeetingDigest } from './api-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const QUEUED: MeetingDigest = { meetingId: 'm1', version: 3, status: 'queued' };

describe('fetchMeetingDigest', () => {
  it("asks for the meeting's digest with the bearer token and returns what the API answers", async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(jsonResponse(200, QUEUED));

    await expect(fetchMeetingDigest('a-signed-jwt', 'm1')).resolves.toEqual(QUEUED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/digest');
    expect(init.method).toBeUndefined();
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });

  it('returns the digest of a meeting that never had one, which is not an error', async () => {
    const none: MeetingDigest = { meetingId: 'm1', version: 0 };
    stubFetch(jsonResponse(200, none));

    // A 200 with version 0: the 404 is kept for a meeting the caller cannot see.
    await expect(fetchMeetingDigest('a-signed-jwt', 'm1')).resolves.toEqual(none);
  });

  it('surfaces the 404 for a meeting the caller cannot see', async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'Meeting not found' }));

    await expect(fetchMeetingDigest('a-signed-jwt', 'm1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Meeting not found',
    });
  });

  it('surfaces a 401 as the ApiError every other call produces', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(fetchMeetingDigest('expired', 'm1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});

describe('requestMeetingDigest', () => {
  it('asks for a generation with a bodiless POST and returns the digest as the request left it', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(jsonResponse(200, QUEUED));

    await expect(requestMeetingDigest('a-signed-jwt', 'm1')).resolves.toEqual(QUEUED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/digest/generation');
    expect(init.method).toBe('POST');
    // One request serves Generate and Retry: the API decides which it was, so nothing is sent.
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });

  it('surfaces the 409 for a digest there is nothing to ask for, with its status', async () => {
    stubFetch(
      jsonResponse(409, { statusCode: 409, message: 'The digest is already being generated' }),
    );

    // The status is what the page acts on: it refetches, and never shows this sentence.
    await expect(requestMeetingDigest('a-signed-jwt', 'm1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
    });
  });

  it('surfaces the 404 for a participant who may not ask', async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'Meeting not found' }));

    await expect(requestMeetingDigest('a-signed-jwt', 'm1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Meeting not found',
    });
  });

  it('surfaces a 401 as the ApiError every other call produces', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(requestMeetingDigest('expired', 'm1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});
