import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchMeetingFiles } from './meeting-file-stream';

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILE: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 10,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
};

const QUEUED: MeetingDigest = { meetingId: 'm1', version: 1, status: 'queued' };
const GENERATING: MeetingDigest = { meetingId: 'm1', version: 2, status: 'generating' };

const event = (name: string, data: unknown): string =>
  `event: ${name}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** One connection whose body is this text, read to its end and not reopened. */
async function watch(text: string, withDigests = true): Promise<string[]> {
  const calls: string[] = [];
  const controller = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    ),
  );

  await watchMeetingFiles({
    token: 'token-1',
    meetingId: 'm1',
    signal: controller.signal,
    onOpen: () => calls.push('open'),
    onFile: (file) => calls.push(`file ${file.id}`),
    ...(withDigests
      ? { onDigest: (digest) => calls.push(`digest ${String(digest.version)} ${digest.status}`) }
      : {}),
    onUnauthorized: vi.fn(),
    onUnavailable: vi.fn(),
    wait: () => {
      controller.abort();

      return Promise.resolve();
    },
  });

  return calls;
}

describe('watchMeetingFiles, for the digest that rides the same stream', () => {
  it('hands a digest event to its own consumer, in order with the files around it', async () => {
    const calls = await watch(
      `${event('digest', QUEUED)}${event('file', FILE)}event: ping\n\n${event('digest', GENERATING)}`,
    );

    // One connection, two consumers: a second stream per page would be a second of a
    // browser's six connections to the API.
    expect(calls).toEqual(['open', 'digest 1 queued', 'file f1', 'digest 2 generating']);
  });

  it('drops a digest event it cannot read, and keeps reading the rest', async () => {
    const calls = await watch(
      [
        event('digest', 'not json'),
        event('digest', { meetingId: 'm1' }),
        event('digest', { version: 3 }),
        event('digest', { meetingId: 'm1', version: '3' }),
        event('digest', GENERATING),
      ].join(''),
    );

    // The next fetch of the digest says whatever an unreadable event described.
    expect(calls).toEqual(['open', 'digest 2 generating']);
  });

  it('never hands a digest to the files, nor a file to the digest', async () => {
    const calls = await watch(`${event('file', QUEUED)}${event('digest', FILE)}`);

    // A digest has no `id` and a file no `version`: each is dropped by the other's reader.
    expect(calls).toEqual(['open']);
  });

  it('reads past digest events for a caller that follows only the files', async () => {
    const calls = await watch(`${event('digest', QUEUED)}${event('file', FILE)}`, false);

    expect(calls).toEqual(['open', 'file f1']);
  });
});
