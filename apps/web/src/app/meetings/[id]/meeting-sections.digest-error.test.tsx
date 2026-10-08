import type { MeetingDigest } from '@repo/shared';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, requestMeetingDigest } from '@/lib/api-client';

import {
  FAILED,
  HOST,
  connectStream,
  deliverDigests,
  digest,
  digestButton,
  digestButtons,
  digestRegion,
  renderSections,
} from './meeting-sections.fixture';

/*
 * How long a failed request's complaint stays on the page. It is about one press, on the
 * control of one digest — so it is on show while that digest is the one held and its control
 * is still offered, and at no other time, whichever of the failure and the stream's events
 * reaches the page first.
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
const REFUSED = new ApiError(500, 'Internal server error');

/** A request the test fails by hand, so the failure can be made to land after an event. */
function heldRequest(): (failure: Error) => Promise<void> {
  const arrival: { reject?: (failure: Error) => void } = {};
  vi.mocked(requestMeetingDigest).mockReturnValue(
    new Promise<MeetingDigest>((_resolve, reject) => {
      arrival.reject = reject;
    }),
  );

  return (failure) =>
    act(async () => {
      arrival.reject?.(failure);
      await Promise.resolve();
    });
}

const press = (name: string): Promise<void> => userEvent.setup().click(digestButton(name));
const alerts = (): HTMLElement[] => screen.queryAllByRole('alert');
const says = (text: string): boolean => digestRegion()?.textContent.includes(text) === true;

beforeEach(() => {
  connectStream();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("a failed request's complaint", () => {
  it('goes with the control it was about, and does not come back', async () => {
    vi.mocked(requestMeetingDigest).mockRejectedValue(REFUSED);
    await renderSections({ viewer: HOST, held: FAILED });
    await press('Retry');
    await waitFor(() => {
      expect(alerts()).toHaveLength(1);
    });

    // Somebody else's Retry was taken: what this one asked for is now under way.
    deliverDigests(QUEUED);
    expect(alerts()).toEqual([]);
    expect(digestButtons('Dismiss')).toEqual([]);

    // And when that one fails too, the control is back without the old complaint beside it.
    deliverDigests(GENERATING, FAILED_AGAIN);
    expect(digestButtons('Retry')).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it('is not shown when it lands after the control has gone, then or later', async () => {
    const fail = heldRequest();
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');
    // The API took the request and the stream said so; the request's own answer was then
    // lost on the way back, which the page hears as a failure.
    deliverDigests(QUEUED);
    await fail(new TypeError('Failed to fetch'));

    // What was asked for is under way: there is nothing to complain of, and nothing to dismiss.
    expect(says('Digest queued')).toBe(true);
    expect(alerts()).toEqual([]);
    expect(digestButtons('Dismiss')).toEqual([]);

    // That generation fails. Its Retry is one nobody has pressed.
    deliverDigests(GENERATING, FAILED_AGAIN);
    expect(digestButtons('Retry')).toHaveLength(1);
    expect(digestButton('Retry').disabled).toBe(false);
    expect(alerts()).toEqual([]);
    expect(digestButtons('Dismiss')).toEqual([]);
  });

  it('goes when the digest it was about is replaced without the control ever leaving', async () => {
    vi.mocked(requestMeetingDigest).mockRejectedValue(REFUSED);
    await renderSections({ viewer: HOST, held: FAILED });
    await press('Retry');
    await waitFor(() => {
      expect(alerts()).toHaveLength(1);
    });

    // One chunk of the stream, so one render: a request, a claim and a second failure. The
    // page never draws a state without Retry in it, and the Retry it ends on is a new one.
    deliverDigests(QUEUED, GENERATING, FAILED_AGAIN);

    expect(digestButtons('Retry')).toHaveLength(1);
    expect(alerts()).toEqual([]);
    expect(digestButtons('Dismiss')).toEqual([]);
  });

  it('is replaced by the next one, and cleared by a press that is taken', async () => {
    vi.mocked(requestMeetingDigest).mockRejectedValueOnce(REFUSED);
    vi.mocked(requestMeetingDigest).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.mocked(requestMeetingDigest).mockResolvedValueOnce(QUEUED);
    await renderSections({ viewer: HOST, held: FAILED });

    await press('Retry');
    await waitFor(() => {
      expect(alerts().map((alert) => alert.textContent)).toEqual(['Internal server error']);
    });

    await press('Retry');
    await waitFor(() => {
      expect(alerts().map((alert) => alert.textContent)).toEqual([
        'The request failed. Try again.',
      ]);
    });

    await press('Retry');
    await waitFor(() => {
      expect(says('Digest queued')).toBe(true);
    });
    expect(alerts()).toEqual([]);
  });
});
