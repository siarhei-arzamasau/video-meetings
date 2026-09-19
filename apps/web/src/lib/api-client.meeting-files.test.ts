import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  deleteMeetingFile,
  downloadMeetingFile,
  fetchThumbnail,
  getMeeting,
  listMeetingFiles,
  uploadMeetingFile,
} from './api-client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

const FILE = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  status: 'uploaded',
  createdAt: '2026-09-01T10:00:00.000Z',
};

describe('getMeeting', () => {
  it('reads one meeting with bearer credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const meeting = {
      id: 'm1',
      title: 'Engine review',
      status: 'scheduled',
      hostId: 'u1',
      scheduledAt: 'x',
      participantIds: [],
    };
    const fetchMock = stubFetch(jsonResponse(200, meeting));

    await expect(getMeeting('a-signed-jwt', 'm1')).resolves.toEqual(meeting);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });

  it('surfaces a 404 as an ApiError the page can turn into not-found', async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'Meeting not found' }));

    await expect(getMeeting('a-signed-jwt', 'm1')).rejects.toMatchObject({
      status: 404,
      message: 'Meeting not found',
    });
  });
});

describe('listMeetingFiles', () => {
  it('reads the files of one meeting, unchanged', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(jsonResponse(200, [FILE]));

    await expect(listMeetingFiles('a-signed-jwt', 'm1')).resolves.toEqual([FILE]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/files');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });
});

describe('deleteMeetingFile', () => {
  it("sends DELETE and resolves to undefined on the API's 204", async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    // No body at all: reading one would throw, which is what the 204 branch exists for.
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(deleteMeetingFile('a-signed-jwt', 'm1', 'f1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/files/f1');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
  });

  it('surfaces the 404 for a file the caller may not delete', async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'File not found' }));

    await expect(deleteMeetingFile('a-signed-jwt', 'm1', 'f1')).rejects.toMatchObject({
      status: 404,
      message: 'File not found',
    });
  });
});

describe('downloadMeetingFile and fetchThumbnail', () => {
  it("returns the content as a Blob with the API's type", async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const blob = await downloadMeetingFile('a-signed-jwt', 'm1', 'f1');

    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/files/f1/content');
    expect(init.headers).toMatchObject({ authorization: 'Bearer a-signed-jwt' });
    // A binary read must not claim to send JSON.
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('reads the thumbnail from its own route', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const fetchMock = stubFetch(
      new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/webp' } }),
    );

    await expect(fetchThumbnail('a-signed-jwt', 'm1', 'f1')).resolves.toMatchObject({
      type: 'image/webp',
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/meetings/m1/files/f1/thumbnail');
  });

  it("rejects with the API's message on a failure body", async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'Thumbnail not found' }));

    await expect(fetchThumbnail('a-signed-jwt', 'm1', 'f1')).rejects.toMatchObject({
      status: 404,
      message: 'Thumbnail not found',
    });
  });
});

/**
 * A stand-in for the browser's `XMLHttpRequest`: records what the client did and lets a test
 * fire the events a real one would. Only the members `uploadMeetingFile` touches exist.
 */
class FakeXhr {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  responseType = '';
  status = 0;
  response: unknown = null;
  sent: FormData | null = null;
  aborted = false;
  readonly upload = new EventTarget();
  private readonly target = new EventTarget();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.target.addEventListener(type, listener);
  }

  send(body: FormData): void {
    this.sent = body;
  }

  abort(): void {
    this.aborted = true;
    this.target.dispatchEvent(new Event('abort'));
  }

  respond(status: number, response: unknown): void {
    this.status = status;
    this.response = response;
    this.target.dispatchEvent(new Event('load'));
  }

  fail(): void {
    this.target.dispatchEvent(new Event('error'));
  }

  progress(loaded: number, total: number): void {
    this.upload.dispatchEvent(
      new ProgressEvent('progress', { lengthComputable: true, loaded, total }),
    );
  }
}

const asXhr = (fake: FakeXhr) => () => fake as unknown as XMLHttpRequest;

describe('uploadMeetingFile', () => {
  const file = new File(['%PDF-1.4'], 'deck.pdf', { type: 'application/pdf' });

  it('POSTs one multipart field named file with bearer credentials and resolves to the record', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    const xhr = new FakeXhr();

    const pending = uploadMeetingFile('a-signed-jwt', 'm1', file, {}, asXhr(xhr));
    xhr.respond(201, FILE);

    await expect(pending).resolves.toEqual(FILE);
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://api.example.com/api/meetings/m1/files');
    expect(xhr.headers).toEqual({ authorization: 'Bearer a-signed-jwt' });
    expect(xhr.responseType).toBe('json');
    expect([...(xhr.sent?.keys() ?? [])]).toEqual(['file']);
    expect(xhr.sent?.get('file')).toBeInstanceOf(File);
  });

  it('reports progress as a fraction when the browser can compute one', async () => {
    const xhr = new FakeXhr();
    const onProgress = vi.fn();

    const pending = uploadMeetingFile('a-signed-jwt', 'm1', file, { onProgress }, asXhr(xhr));
    xhr.progress(25, 100);
    xhr.progress(100, 100);
    xhr.respond(201, FILE);
    await pending;

    expect(onProgress.mock.calls).toEqual([[0.25], [1]]);
  });

  it("rejects with an ApiError carrying the API's message on a non-2xx", async () => {
    const xhr = new FakeXhr();

    const pending = uploadMeetingFile('a-signed-jwt', 'm1', file, {}, asXhr(xhr));
    xhr.respond(415, { statusCode: 415, message: 'That file type is not supported.' });

    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toMatchObject({
      status: 415,
      message: 'That file type is not supported.',
    });
  });

  it('falls back to the status when the failure body carries no message', async () => {
    const xhr = new FakeXhr();

    const pending = uploadMeetingFile('a-signed-jwt', 'm1', file, {}, asXhr(xhr));
    xhr.respond(502, null);

    await expect(pending).rejects.toThrowError(/failed with 502/);
  });

  it('aborts the request from the signal and rejects with an AbortError', async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();

    const pending = uploadMeetingFile(
      'a-signed-jwt',
      'm1',
      file,
      { signal: controller.signal },
      asXhr(xhr),
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
  });

  it('rejects at once, without sending, when the signal is already aborted', async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadMeetingFile('a-signed-jwt', 'm1', file, { signal: controller.signal }, asXhr(xhr)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.sent).toBeNull();
  });

  it('rejects like fetch does when the request never reached the API', async () => {
    const xhr = new FakeXhr();

    const pending = uploadMeetingFile('a-signed-jwt', 'm1', file, {}, asXhr(xhr));
    xhr.fail();

    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });
});
