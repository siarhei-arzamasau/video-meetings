import type { User } from '@repo/shared';
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';

import {
  FAILED,
  HOST,
  NEVER_GENERATED,
  PARTICIPANT,
  RECORDING,
  UPLOADER,
  connectStream,
  digest,
  digestButtons,
  digestRegion,
  renderSections,
  stream,
} from './meeting-sections.fixture';

/*
 * Who is shown the digest's control: the page's own part of Retry, worked out from the
 * files list it already holds — and that a digest nobody has to ask for is offered to
 * nobody. Only the API and the stream are replaced.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
  requestMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const MAY_ASK: ReadonlyArray<[string, User]> = [
  ['the host', HOST],
  ["the recording's uploader", UPLOADER],
];

beforeEach(() => {
  connectStream();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const OUT_OF_DATE = digest(3, {
  status: 'ready',
  content: {
    summary: 'The team agreed the launch plan.',
    actionItems: [],
    decisions: [],
    generatedAt: '2026-10-08T09:00:00.000Z',
    outOfDate: true,
  },
});

describe('a digest that nobody has to ask for', () => {
  it.each([...MAY_ASK, ['another participant', PARTICIPANT] as [string, User]])(
    'shows %s no section at all for recordings that have no digest yet',
    async (_who, viewer) => {
      await renderSections({ viewer, held: NEVER_GENERATED });

      // Nothing to read and nothing to press: the API generates it the next time it starts.
      expect(digestRegion()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Generate digest' })).toBeNull();
    },
  );

  it.each(MAY_ASK)(
    'shows %s an out-of-date digest marked and readable, with nothing to press',
    async (_who, viewer) => {
      await renderSections({ viewer, held: OUT_OF_DATE });
      const region = digestRegion();

      expect(region?.textContent).toContain('Out of date');
      expect(region?.textContent).toContain('The team agreed the launch plan.');
      expect(region === null ? [] : within(region).queryAllByRole('button')).toEqual([]);
    },
  );
});

describe('Retry', () => {
  it.each(MAY_ASK)(
    'is offered to %s on a failed digest, beside its reason',
    async (_who, viewer) => {
      await renderSections({ viewer, held: FAILED });

      expect(digestButtons('Retry')).toHaveLength(1);
      expect(digestRegion()?.textContent).toContain('Digest failed');
      expect(digestRegion()?.textContent).toContain('The digest could not be generated.');
    },
  );

  it('is not offered to another participant, who still sees the failure and its reason', async () => {
    await renderSections({ viewer: PARTICIPANT, held: FAILED });
    const region = digestRegion();

    expect(region?.textContent).toContain('Digest failed');
    expect(region?.textContent).toContain('The digest could not be generated.');
    expect(region === null ? [] : within(region).queryAllByRole('button')).toEqual([]);
  });

  it('is not offered to the host while the list holds no transcribed recording', async () => {
    const untranscribed = { ...RECORDING, transcriptionStatus: 'failed' as const };

    await renderSections({ viewer: HOST, held: FAILED, files: [untranscribed] });

    // The failure is still what the digest says; there is nothing left to retry it from.
    expect(digestRegion()?.textContent).toContain('Digest failed');
    expect(digestButtons('Retry')).toEqual([]);
  });

  it('leaves with the last transcribed recording, though the digest still says retry', async () => {
    await renderSections({ viewer: HOST, held: FAILED });
    expect(digestButtons('Retry')).toHaveLength(1);

    // The delete reaches the list by the stream. When nothing reacts to it nothing reaches
    // the digest, whose version has not moved: the page goes on holding `retry`.
    act(() => stream.file({ ...RECORDING, status: 'deleted' }));

    expect(digestRegion()?.textContent).toContain('Digest failed');
    expect(digestButtons('Retry')).toEqual([]);
  });
});

describe('no control', () => {
  it.each([
    ['queued', digest(5, { status: 'queued' })],
    ['being generated', digest(6, { status: 'generating' })],
    [
      'current',
      digest(7, {
        status: 'ready',
        content: {
          summary: 'The team agreed the launch plan.',
          actionItems: [],
          decisions: [],
          generatedAt: '2026-10-08T09:00:00.000Z',
          outOfDate: false,
        },
      }),
    ],
  ])('is on the page of the host while the digest is %s', async (_case, held) => {
    await renderSections({ viewer: HOST, held });
    const region = digestRegion();

    expect(region).not.toBeNull();
    expect(region === null ? [] : within(region).queryAllByRole('button')).toEqual([]);
  });
});
