import type { MeetingDigest } from '@repo/shared';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, fetchMeetingDigest, requestMeetingDigest } from '@/lib/api-client';

import {
  FAILED,
  HOST,
  NEVER_GENERATED,
  connectStream,
  deliverDigests,
  digest,
  digestButton,
  digestButtons,
  digestRegion,
  onUnauthorized,
  renderSections,
} from './meeting-sections.fixture';

/*
 * The control, `useDigestAction`, the section and the digest's feed together, with only the
 * API and the stream replaced. What is pinned here is what becomes of each answer the
 * request can get — and the order between that answer and the stream, which the digest's
 * version settles and nothing else on the page can.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
  requestMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const QUEUED = digest(5, { status: 'queued' });
const GENERATING = digest(6, { status: 'generating' });
const FAILED_AGAIN = digest(7, { ...FAILED, version: 7 });

/** A request the test answers by hand, so the answer can be made to arrive after an event. */
function heldRequest(): (answer: MeetingDigest) => Promise<void> {
  const arrival: { resolve?: (answered: MeetingDigest) => void } = {};
  vi.mocked(requestMeetingDigest).mockReturnValue(
    new Promise<MeetingDigest>((resolve) => {
      arrival.resolve = resolve;
    }),
  );

  return (answer) =>
    act(async () => {
      arrival.resolve?.(answer);
      await Promise.resolve();
    });
}

const press = (name: string): Promise<void> => userEvent.setup().click(digestButton(name));
const alerts = (): HTMLElement[] => screen.queryAllByRole('alert');
const digestFetches = (): number => vi.mocked(fetchMeetingDigest).mock.calls.length;
const says = (text: string): boolean => digestRegion()?.textContent.includes(text) === true;

beforeEach(() => {
  connectStream();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('asking for a digest from the page', () => {
  it('sends the one request and takes its answer as the digest: queued, and no control', async () => {
    vi.mocked(requestMeetingDigest).mockResolvedValue(digest(1, { status: 'queued' }));
    await renderSections({ viewer: HOST, held: NEVER_GENERATED });

    await press('Generate digest');

    await waitFor(() => {
      expect(says('Digest queued')).toBe(true);
    });
    expect(requestMeetingDigest).toHaveBeenCalledExactlyOnceWith('a-signed-jwt', 'm1');
    expect(digestButtons('Generate digest')).toEqual([]);
    expect(says('no digest yet')).toBe(false);
    // The answer carries a version, so it is taken as it is: nothing is fetched to learn it.
    expect(digestFetches()).toBe(1);
  });

  it('keeps focus in the section when the control it was on goes', async () => {
    vi.mocked(requestMeetingDigest).mockResolvedValue(QUEUED);
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');
    await waitFor(() => {
      expect(digestButtons('Retry')).toEqual([]);
    });

    // A button removed while it holds focus drops a keyboard reader at the top of the page.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Digest' }));
  });

  it('cannot be pressed twice while the request is on its way', async () => {
    const answer = heldRequest();
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');

    expect(digestButton('Retry').disabled).toBe(true);

    await answer(QUEUED);
    expect(requestMeetingDigest).toHaveBeenCalledTimes(1);
  });

  it('does not put the digest back to queued when the stream got there first', async () => {
    const answer = heldRequest();
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');
    // The request itself, a worker's claim, and a second failure: all three overtake the
    // answer, which is still on its way on a connection of its own.
    deliverDigests(QUEUED, GENERATING, FAILED_AGAIN);
    await answer(QUEUED);

    // What the stream said last stays: failed, and retryable again.
    expect(says('Digest failed')).toBe(true);
    expect(says('Digest queued')).toBe(false);
    expect(digestButtons('Retry')).toHaveLength(1);
    expect(digestButton('Retry').disabled).toBe(false);
  });

  it('answers a 409 by fetching the digest again, and shows none of what the API said', async () => {
    vi.mocked(requestMeetingDigest).mockRejectedValue(
      new ApiError(409, 'The digest is already being generated'),
    );
    await renderSections({ viewer: HOST, held: FAILED });
    // Somebody else asked first, and this page had not heard: only a fetch can say so.
    vi.mocked(fetchMeetingDigest).mockResolvedValue(GENERATING);
    const before = digestFetches();

    await press('Retry');

    await waitFor(() => {
      expect(says('Generating digest…')).toBe(true);
    });
    expect(digestFetches()).toBe(before + 1);
    expect(alerts()).toEqual([]);
    expect(says('already being generated')).toBe(false);
    expect(digestButtons('Retry')).toEqual([]);
  });

  it.each<[string, Error, string]>([
    ['the API refuses it', new ApiError(500, 'Internal server error'), 'Internal server error'],
    [
      'it never reaches the API',
      new TypeError('Failed to fetch'),
      'The request failed. Try again.',
    ],
  ])(
    'shows the failure inline with Dismiss, and keeps the control, when %s',
    async (_case, failure, message) => {
      vi.mocked(requestMeetingDigest).mockRejectedValue(failure);
      await renderSections({ viewer: HOST, held: FAILED });

      await press('Retry');

      await waitFor(() => {
        expect(alerts().map((alert) => alert.textContent)).toEqual([message]);
      });
      const region = digestRegion();
      expect(region === null ? [] : within(region).queryAllByRole('alert')).toHaveLength(1);
      expect(digestButton('Retry').disabled).toBe(false);
      expect(digestFetches()).toBe(1);

      await press('Dismiss');

      expect(alerts()).toEqual([]);
      expect(digestButtons('Dismiss')).toEqual([]);
      expect(digestButtons('Retry')).toHaveLength(1);
    },
  );

  it('hands a 401 to the gate rather than showing it', async () => {
    vi.mocked(requestMeetingDigest).mockRejectedValue(new ApiError(401, 'Unauthorized'));
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(alerts()).toEqual([]);
  });
});
