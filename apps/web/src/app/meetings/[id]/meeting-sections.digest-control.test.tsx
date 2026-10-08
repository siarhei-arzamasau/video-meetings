import type { User } from '@repo/shared';
import { act, cleanup, within } from '@testing-library/react';
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
 * Who is shown the digest's control: the page's own part of Generate and Retry, worked out
 * from the files list it already holds. Only the API and the stream are replaced.
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

describe('Generate digest', () => {
  it.each(MAY_ASK)(
    'is offered to %s for recordings transcribed with the setting off',
    async (_who, viewer) => {
      await renderSections({ viewer, held: NEVER_GENERATED });

      expect(digestButtons('Generate digest')).toHaveLength(1);
      // A button under a bare heading does not say what it is for.
      expect(digestRegion()?.textContent).toContain(
        "This meeting's recordings have no digest yet.",
      );
      // The note is about a digest's text, and there is none.
      expect(digestRegion()?.textContent).not.toContain('AI-generated');
    },
  );

  it('is not offered to another participant, who is shown no section at all', async () => {
    await renderSections({ viewer: PARTICIPANT, held: NEVER_GENERATED });

    expect(digestRegion()).toBeNull();
  });

  it.each(MAY_ASK)(
    'is offered to %s beside an out-of-date digest nothing is replacing',
    async (_who, viewer) => {
      const stale = digest(3, {
        status: 'ready',
        availableAction: 'generate',
        content: {
          summary: 'The team agreed the launch plan.',
          actionItems: [],
          decisions: [],
          generatedAt: '2026-10-08T09:00:00.000Z',
          outOfDate: true,
        },
      });

      await renderSections({ viewer, held: stale });

      expect(digestButtons('Generate digest')).toHaveLength(1);
      expect(digestRegion()?.textContent).toContain('Out of date');
      expect(digestRegion()?.textContent).toContain('The team agreed the launch plan.');
    },
  );

  it('is not offered to the host while the list holds no transcribed recording', async () => {
    const untranscribed = { ...RECORDING, transcriptionStatus: 'failed' as const };

    await renderSections({ viewer: HOST, held: NEVER_GENERATED, files: [untranscribed] });

    expect(digestRegion()).toBeNull();
  });

  it('leaves with the last transcribed recording, though the digest still says generate', async () => {
    await renderSections({ viewer: HOST, held: NEVER_GENERATED });
    expect(digestButtons('Generate digest')).toHaveLength(1);

    // The delete reaches the list by the stream. Nothing reaches the digest: a meeting with
    // nothing stored has no version to move, so the page goes on holding `generate`.
    act(() => stream.file({ ...RECORDING, status: 'deleted' }));

    expect(digestRegion()).toBeNull();
  });
});

describe('Retry', () => {
  it.each(MAY_ASK)(
    'is offered to %s on a failed digest, beside its reason',
    async (_who, viewer) => {
      await renderSections({ viewer, held: FAILED });

      expect(digestButtons('Retry')).toHaveLength(1);
      expect(digestRegion()?.textContent).toContain('Digest failed');
      expect(digestRegion()?.textContent).toContain('The digest could not be generated.');
      // The failure is what the section says; there is no sentence about there being no digest.
      expect(digestRegion()?.textContent).not.toContain('no digest yet');
    },
  );

  it('is not offered to another participant, who still sees the failure and its reason', async () => {
    await renderSections({ viewer: PARTICIPANT, held: FAILED });
    const region = digestRegion();

    expect(region?.textContent).toContain('Digest failed');
    expect(region?.textContent).toContain('The digest could not be generated.');
    expect(region === null ? [] : within(region).queryAllByRole('button')).toEqual([]);
  });
});

describe('neither control', () => {
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
