import type { MeetingFile } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryMeetingFileTranscription } from './api-client';

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

/** What the route answers with: the file as it was, its transcription queued, no reason. */
const REQUEUED: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  transcriptionStatus: 'queued',
  createdAt: '2026-10-01T10:00:00.000Z',
};

describe('retryMeetingFileTranscription', () => {
  it('sends POST to the transcription retry route and returns the file the API answers with', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(jsonResponse(200, REQUEUED));

    await expect(retryMeetingFileTranscription('a-signed-jwt', 'm1', 'f1')).resolves.toEqual(
      REQUEUED,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Its own route: `/files/f1/retry` is the file's retry, and would send a ready recording
    // nowhere but a 409.
    expect(url).toBe('https://api.example.com/api/meetings/m1/files/f1/transcription/retry');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
    expect(init.body).toBeUndefined();
  });

  it("surfaces the 409 for a transcription that is no longer failed, with the API's message", async () => {
    stubFetch(
      jsonResponse(409, { statusCode: 409, message: 'Only a failed transcription can be retried' }),
    );

    await expect(retryMeetingFileTranscription('a-signed-jwt', 'm1', 'f1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Only a failed transcription can be retried',
    });
  });

  it('surfaces the 404 for a recording the caller may not retry', async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'File not found' }));

    await expect(retryMeetingFileTranscription('a-signed-jwt', 'm1', 'f1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'File not found',
    });
  });

  it('surfaces a 401 as the ApiError every other call produces', async () => {
    stubFetch(jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }));

    await expect(retryMeetingFileTranscription('expired', 'm1', 'f1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});
