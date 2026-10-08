import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTranscript } from './api-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

const textResponse = (body: string, contentType = 'text/plain; charset=utf-8'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } });

const failure = (status: number, message: string): Response =>
  new Response(JSON.stringify({ statusCode: status, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('fetchTranscript', () => {
  it('reads the transcript route with bearer credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(textResponse('Good morning, everyone.'));

    const transcript = await fetchTranscript('a-signed-jwt', 'm1', 'f1');

    await expect(transcript.text()).resolves.toBe('Good morning, everyone.');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/files/f1/transcript');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
    // A read with no body must not claim to send JSON.
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('hands back plain text in UTF-8, the type the API declares', async () => {
    stubFetch(textResponse('Доброе утро. おはよう。'));

    const transcript = await fetchTranscript('a-signed-jwt', 'm1', 'f1');

    expect(transcript.type).toBe('text/plain;charset=utf-8');
    await expect(transcript.text()).resolves.toBe('Доброе утро. おはよう。');
  });

  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', ''])(
    'opens as plain text even when the response calls itself "%s"',
    async (claimed) => {
      // The caller opens this blob as a document on the app's own origin. Under the type
      // the response claimed, markup in it would run beside the token in `localStorage`.
      const markup = '<script>document.title = localStorage.length</script>';
      stubFetch(new Response(markup, { status: 200, headers: { 'content-type': claimed } }));

      const transcript = await fetchTranscript('a-signed-jwt', 'm1', 'f1');

      expect(transcript.type).toBe('text/plain;charset=utf-8');
      // The same bytes, to be shown as the characters they are.
      await expect(transcript.text()).resolves.toBe(markup);
    },
  );

  it("surfaces the 404 for a recording with no transcript, with the API's message", async () => {
    stubFetch(failure(404, 'Transcript not found'));

    await expect(fetchTranscript('a-signed-jwt', 'm1', 'f1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Transcript not found',
    });
  });

  it('surfaces a 401 as the ApiError every other call produces', async () => {
    stubFetch(failure(401, 'Unauthorized'));

    await expect(fetchTranscript('expired', 'm1', 'f1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});
