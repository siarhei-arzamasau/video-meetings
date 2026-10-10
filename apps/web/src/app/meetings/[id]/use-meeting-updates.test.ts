import type { MeetingDigest, MeetingFile } from '@repo/shared';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import type { MeetingUpdates } from './use-meeting-updates';
import { useMeetingUpdates } from './use-meeting-updates';

/*
 * The page's two consumers of one stream, with only the API and the stream replaced. What is
 * pinned here is the order between a fetch of the digest and an event about it, which the
 * version settles and nothing else on the page can.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetingFiles: vi.fn(),
  fetchMeetingDigest: vi.fn(),
}));
vi.mock('@/lib/meeting-file-stream', () => ({ watchMeetingFiles: vi.fn() }));

const digest = (version: number, overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version,
  ...overrides,
});

const onUnauthorized = vi.fn();
const nothing = (): void => undefined;

/** The page's end of the stream: what a test calls to open it or to have an event arrive. */
const stream: {
  open: () => void;
  file: (file: MeetingFile) => void;
  digest: (digest: MeetingDigest) => void;
} = { open: nothing, file: nothing, digest: nothing };

/** A fetch of the digest the test answers by hand, so it can land after an event. */
function heldDigestFetch(): (answer: MeetingDigest) => Promise<void> {
  const arrival: { resolve?: (digest: MeetingDigest) => void } = {};
  vi.mocked(fetchMeetingDigest).mockReturnValueOnce(
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

const settle = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

async function mount(): Promise<{ current: MeetingUpdates }> {
  const { result } = renderHook(() => useMeetingUpdates('a-signed-jwt', 'm1', onUnauthorized));
  await settle();

  return result;
}

const digestRequests = (): number => vi.mocked(fetchMeetingDigest).mock.calls.length;

beforeEach(() => {
  vi.mocked(listMeetingFiles).mockResolvedValue([]);
  vi.mocked(fetchMeetingDigest).mockResolvedValue(digest(0));
  // Connected, and silent until a test says otherwise.
  vi.mocked(watchMeetingFiles).mockImplementation(({ onOpen, onFile, onDigest }) => {
    stream.open = onOpen;
    stream.file = onFile;
    stream.digest = onDigest ?? nothing;

    return new Promise<void>(() => undefined);
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the digest on the meeting page', () => {
  it('is nothing until the API has answered, and then what it answered', async () => {
    const answer = heldDigestFetch();
    const page = await mount();

    expect(page.current.digest).toBeNull();

    await answer(digest(3, { status: 'queued' }));

    expect(page.current.digest).toEqual(digest(3, { status: 'queued' }));
    expect(fetchMeetingDigest).toHaveBeenCalledWith('a-signed-jwt', 'm1');
  });

  it('is fetched again every time the stream opens, beside the list', async () => {
    await mount();
    const before = {
      digests: digestRequests(),
      lists: vi.mocked(listMeetingFiles).mock.calls.length,
    };

    act(() => stream.open());
    await settle();
    act(() => stream.open());
    await settle();

    // Only a digest requested after the server subscribed this connection holds whatever no
    // event will repeat — and that is true again after every reconnect.
    expect(digestRequests()).toBe(before.digests + 2);
    expect(vi.mocked(listMeetingFiles).mock.calls.length).toBe(before.lists + 2);
  });

  it('follows the stream, one stream for the files and the digest alike', async () => {
    const page = await mount();

    act(() => stream.digest(digest(1, { status: 'queued' })));
    act(() => stream.digest(digest(2, { status: 'generating' })));

    expect(page.current.digest?.status).toBe('generating');
    expect(watchMeetingFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps the higher version when a fetch lands after the event that overtook it', async () => {
    const page = await mount();
    const answer = heldDigestFetch();
    act(() => stream.open());

    // The API read the digest as queued, and the claim was announced before that answer
    // arrived on its own connection.
    act(() => stream.digest(digest(2, { status: 'generating' })));
    await answer(digest(1, { status: 'queued' }));

    expect(page.current.digest).toEqual(digest(2, { status: 'generating' }));
  });

  it('keeps the higher version when an event arrives late', async () => {
    const page = await mount();

    act(() => stream.digest(digest(5, { status: 'ready' })));
    act(() => stream.digest(digest(4, { status: 'generating' })));

    expect(page.current.digest?.status).toBe('ready');
  });

  it('takes a fetched digest over one of the same version it holds', async () => {
    const withoutRetry = digest(5, { status: 'failed' });
    const page = await mount();
    act(() => stream.digest(digest(5, { status: 'failed', availableAction: 'retry' })));

    // A Retry that left with a recording nothing reacted to the delete of changes the answer
    // and not the version, as a linked owner's new name does: only a fetch has either.
    vi.mocked(fetchMeetingDigest).mockResolvedValue(withoutRetry);
    act(() => stream.open());
    await settle();

    expect(page.current.digest).toBe(withoutRetry);
  });

  it("drops an event about another meeting's digest", async () => {
    const page = await mount();

    act(() => stream.digest({ meetingId: 'm2', version: 9, status: 'ready' }));

    expect(page.current.digest).toEqual(digest(0));
  });

  it('keeps the digest it holds when a fetch fails', async () => {
    const page = await mount();
    act(() => stream.digest(digest(2, { status: 'generating' })));

    vi.mocked(fetchMeetingDigest).mockRejectedValue(new TypeError('Failed to fetch'));
    act(() => stream.open());
    await settle();

    expect(page.current.digest?.status).toBe('generating');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('hands a 401 to the gate rather than showing it', async () => {
    vi.mocked(fetchMeetingDigest).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const page = await mount();

    expect(onUnauthorized).toHaveBeenCalled();
    expect(page.current.digest).toBeNull();
  });

  it('leaves the list its own refresh: a row that refetches the files asks for no digest', async () => {
    const page = await mount();
    const before = digestRequests();

    act(() => page.current.files.refresh());
    await settle();

    expect(digestRequests()).toBe(before);
  });
});
