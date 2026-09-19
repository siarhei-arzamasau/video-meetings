import type { MeetingFile, MeetingFileUpload } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-client';
import type { ChunkedUploadDeps } from './chunked-upload';
import { CHUNK_RETRIES, fingerprint, planChunks, uploadInChunks } from './chunked-upload';

const CHUNK = 8;

const FILE: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'recording.mp4',
  contentType: 'video/mp4',
  size: 20,
  status: 'uploaded',
  createdAt: '2026-09-19T10:00:00.000Z',
};

const session = (overrides: Partial<MeetingFileUpload> = {}): MeetingFileUpload => ({
  id: 'up1',
  meetingId: 'm1',
  name: 'recording.mp4',
  size: 20,
  chunkSize: CHUNK,
  chunkCount: 3,
  receivedChunks: [],
  createdAt: '2026-09-19T10:00:00.000Z',
  expiresAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

/** A 20-byte file: two full chunks of 8 and a 4-byte tail. */
const file = (name = 'recording.mp4', size = 20): File =>
  new File([new Uint8Array(size)], name, { lastModified: 1_700_000_000_000 });

interface Transport extends ChunkedUploadDeps {
  sent: number[];
}

/** A transport that records the chunk indexes it was asked to send. */
function fakeTransport(overrides: Partial<ChunkedUploadDeps> = {}): Transport {
  const sent: number[] = [];

  return {
    sent,
    createUpload: vi.fn().mockResolvedValue(session()),
    getUpload: vi.fn().mockResolvedValue(session()),
    putChunk: vi.fn().mockImplementation((_t, _m, _u, index: number) => {
      sent.push(index);

      return Promise.resolve();
    }),
    completeUpload: vi.fn().mockResolvedValue(FILE),
    // No waiting in a unit test; the backoff's own length is not what is being pinned.
    delay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('planChunks', () => {
  it('gives every chunk but the last the full size, and the last the remainder', () => {
    expect(planChunks(20, 8)).toEqual([
      { index: 0, start: 0, end: 8 },
      { index: 1, start: 8, end: 16 },
      { index: 2, start: 16, end: 20 },
    ]);
  });

  it('gives an exact multiple a full last chunk', () => {
    expect(planChunks(16, 8)).toEqual([
      { index: 0, start: 0, end: 8 },
      { index: 1, start: 8, end: 16 },
    ]);
  });

  it('gives a file smaller than one chunk a single range', () => {
    expect(planChunks(3, 8)).toEqual([{ index: 0, start: 0, end: 3 }]);
  });

  it.each([
    ['an empty file', 0, 8],
    ['a negative size', -1, 8],
    ['a zero chunk size', 20, 0],
  ])('plans nothing for %s', (_description, size, chunkSize) => {
    expect(planChunks(size, chunkSize)).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('is the name, the size, and the last-modified instant', () => {
    expect(fingerprint({ name: 'a.mp4', size: 20, lastModified: 17 })).toBe('a.mp4:20:17');
  });

  it('differs when any one of the three does', () => {
    const base = { name: 'a.mp4', size: 20, lastModified: 17 };

    expect(fingerprint({ ...base, name: 'b.mp4' })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, size: 21 })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, lastModified: 18 })).not.toBe(fingerprint(base));
  });
});

describe('uploadInChunks', () => {
  it('opens a session, sends every chunk in order, and completes', async () => {
    const transport = fakeTransport();

    await expect(uploadInChunks('t', 'm1', file(), {}, transport)).resolves.toEqual(FILE);

    expect(transport.sent).toEqual([0, 1, 2]);
    expect(transport.completeUpload).toHaveBeenCalledWith('t', 'm1', 'up1');
  });

  it('slices each chunk to the range the server expects', async () => {
    const transport = fakeTransport();

    await uploadInChunks('t', 'm1', file(), {}, transport);

    const sizes = (transport.putChunk as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[4] as Blob).size,
    );
    expect(sizes).toEqual([8, 8, 4]);
  });

  it('reports the session id before any chunk, so a reload can resume it', async () => {
    const transport = fakeTransport();
    const seen: string[] = [];

    await uploadInChunks(
      't',
      'm1',
      file(),
      {
        onSession: (id) => {
          seen.push(`session ${id} after ${String(transport.sent.length)} chunks`);
        },
      },
      transport,
    );

    expect(seen).toEqual(['session up1 after 0 chunks']);
  });

  it('reports progress as bytes acknowledged over the total', async () => {
    const transport = fakeTransport();
    const fractions: number[] = [];

    await uploadInChunks('t', 'm1', file(), { onProgress: (f) => fractions.push(f) }, transport);

    expect(fractions).toEqual([0, 0.4, 0.8, 1]);
  });

  describe('resuming', () => {
    it('sends only the chunks the server is missing, and starts the percentage there', async () => {
      const transport = fakeTransport({
        getUpload: vi.fn().mockResolvedValue(session({ receivedChunks: [0, 1] })),
      });
      const fractions: number[] = [];
      const resumed: string[] = [];

      await uploadInChunks(
        't',
        'm1',
        file(),
        {
          resumeFrom: 'up1',
          onProgress: (f) => fractions.push(f),
          onResume: (received, total) => resumed.push(`${String(received)}/${String(total)}`),
        },
        transport,
      );

      expect(transport.sent).toEqual([2]);
      expect(transport.createUpload).not.toHaveBeenCalled();
      expect(fractions[0]).toBe(0.8);
      expect(resumed).toEqual(['2/3']);
    });

    it('does not announce a resume when the server has nothing yet', async () => {
      const transport = fakeTransport();
      const onResume = vi.fn();

      await uploadInChunks('t', 'm1', file(), { resumeFrom: 'up1', onResume }, transport);

      expect(onResume).not.toHaveBeenCalled();
    });

    it.each([
      ['a session the server no longer has', { get: () => Promise.reject(notFound()) }],
      ['a session for a file of another size', { session: session({ size: 999 }) }],
      ['a session for a file of another name', { session: session({ name: 'other.mp4' }) }],
    ])('starts a new session for %s', async (_description, scenario) => {
      const details = scenario as { get?: () => Promise<never>; session?: MeetingFileUpload };
      const transport = fakeTransport({
        getUpload: vi
          .fn()
          .mockImplementation(details.get ?? (() => Promise.resolve(details.session))),
      });

      await expect(
        uploadInChunks('t', 'm1', file(), { resumeFrom: 'stale' }, transport),
      ).resolves.toEqual(FILE);

      expect(transport.createUpload).toHaveBeenCalledTimes(1);
      expect(transport.sent).toEqual([0, 1, 2]);
    });

    it('surfaces a network failure while looking the session up, rather than starting over', async () => {
      const transport = fakeTransport({
        getUpload: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      });

      await expect(
        uploadInChunks('t', 'm1', file(), { resumeFrom: 'up1' }, transport),
      ).rejects.toBeInstanceOf(TypeError);

      expect(transport.createUpload).not.toHaveBeenCalled();
    });
  });

  describe('retrying a chunk', () => {
    it('re-sends after a network failure and carries on', async () => {
      let failures = 2;
      const transport = fakeTransport({
        putChunk: vi.fn().mockImplementation((_t, _m, _u, index: number) => {
          if (index === 1 && failures > 0) {
            failures -= 1;

            return Promise.reject(new TypeError('Failed to fetch'));
          }

          return Promise.resolve();
        }),
      });

      await expect(uploadInChunks('t', 'm1', file(), {}, transport)).resolves.toEqual(FILE);

      // Chunk 1 was sent three times in all; nothing else was sent twice.
      const indexes = (transport.putChunk as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[3] as number,
      );
      expect(indexes).toEqual([0, 1, 1, 1, 2]);
      expect(transport.delay).toHaveBeenCalledTimes(2);
    });

    it(`gives up after ${String(CHUNK_RETRIES)} retries and surfaces the failure`, async () => {
      const transport = fakeTransport({
        putChunk: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      });

      await expect(uploadInChunks('t', 'm1', file(), {}, transport)).rejects.toBeInstanceOf(
        TypeError,
      );

      expect(transport.putChunk).toHaveBeenCalledTimes(CHUNK_RETRIES + 1);
      expect(transport.completeUpload).not.toHaveBeenCalled();
    });

    it('does not retry an answer from the server', async () => {
      const transport = fakeTransport({
        putChunk: vi.fn().mockRejectedValue(new ApiError(400, 'Chunk length does not match')),
      });

      await expect(uploadInChunks('t', 'm1', file(), {}, transport)).rejects.toMatchObject({
        status: 400,
      });

      expect(transport.putChunk).toHaveBeenCalledTimes(1);
      expect(transport.delay).not.toHaveBeenCalled();
    });
  });

  describe('cancelling', () => {
    it('sends nothing at all when the signal is already aborted', async () => {
      const transport = fakeTransport();
      const controller = new AbortController();
      controller.abort();

      await expect(
        uploadInChunks('t', 'm1', file(), { signal: controller.signal }, transport),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(transport.createUpload).not.toHaveBeenCalled();
    });

    it('stops between chunks and does not complete', async () => {
      const controller = new AbortController();
      const transport = fakeTransport({
        putChunk: vi.fn().mockImplementation((_t, _m, _u, index: number) => {
          if (index === 0) {
            controller.abort();
          }

          return Promise.resolve();
        }),
      });

      await expect(
        uploadInChunks('t', 'm1', file(), { signal: controller.signal }, transport),
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(transport.putChunk).toHaveBeenCalledTimes(1);
      expect(transport.completeUpload).not.toHaveBeenCalled();
    });
  });
});

function notFound(): ApiError {
  return new ApiError(404, 'Upload not found');
}
