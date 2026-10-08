import type { MeetingFile } from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, fetchTranscript } from '@/lib/api-client';

import { FileRow } from './file-row';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  fetchTranscript: vi.fn(),
}));

const TRANSCRIBED: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
  transcriptionStatus: 'transcribed',
  transcriptPath: '/meetings/m1/files/f1/transcript',
};

const onUnauthorized = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

/** The tab `window.open` hands back: only what the row touches. */
const tab = { opener: {} as unknown, close: vi.fn(), location: { replace: vi.fn() } };
const openTab = vi.fn();

function renderRow(file: MeetingFile) {
  return render(
    <FileRow
      token="a-signed-jwt"
      file={file}
      isMine
      canManage
      onDelete={vi.fn()}
      onRetried={vi.fn()}
      onStale={vi.fn()}
      onUnauthorized={onUnauthorized}
    />,
  );
}

const openTranscript = (): HTMLElement => screen.getByRole('link', { name: /Open transcript/ });

beforeEach(() => {
  let next = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:transcript-${String(++next)}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

  tab.opener = {};
  openTab.mockReset().mockReturnValue(tab);
  vi.stubGlobal('open', openTab);
  vi.mocked(fetchTranscript).mockResolvedValue(new Blob(['Good morning, everyone.']));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** What a press on the link does. What the row shows for each status is the file beside this. */
describe('opening a transcript', () => {
  it('opens the tab inside the press, then points it at the fetched text', async () => {
    // Settled by hand, so the assertions between the press and the answer have a between.
    const arrival: { resolve?: (transcript: Blob) => void } = {};
    vi.mocked(fetchTranscript).mockReturnValue(
      new Promise<Blob>((resolve) => {
        arrival.resolve = resolve;
      }),
    );
    const transcript = new Blob(['Good morning, everyone.']);
    renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());

    // Before a byte has arrived: a tab opened after the await is a popup a browser may block.
    expect(openTab).toHaveBeenCalledWith('', '_blank');
    expect(fetchTranscript).toHaveBeenCalledWith('a-signed-jwt', 'm1', 'f1');
    expect(tab.location.replace).not.toHaveBeenCalled();

    arrival.resolve?.(transcript);

    await waitFor(() => {
      expect(tab.location.replace).toHaveBeenCalledWith('blob:transcript-1');
    });
    expect(createObjectURL).toHaveBeenCalledWith(transcript);
    // Plain text cannot reach back, and now neither could anything else shown there.
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the object URL while the row is on the page, and revokes it when the row goes', async () => {
    const { unmount } = renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());
    await waitFor(() => {
      expect(tab.location.replace).toHaveBeenCalledTimes(1);
    });

    // Revoked now, the tab could not be reloaded.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:transcript-1');
  });

  it('closes the tab when the row goes before the text arrives', async () => {
    const arrival: { resolve?: (transcript: Blob) => void } = {};
    vi.mocked(fetchTranscript).mockReturnValue(
      new Promise<Blob>((resolve) => {
        arrival.resolve = resolve;
      }),
    );
    const { unmount } = renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());
    unmount();
    arrival.resolve?.(new Blob(['Good morning, everyone.']));

    // Nothing is left that would ever revoke a URL made now.
    await waitFor(() => {
      expect(tab.close).toHaveBeenCalledTimes(1);
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('signs out on a 401 and leaves no empty tab behind', async () => {
    vi.mocked(fetchTranscript).mockRejectedValue(new ApiError(401, 'Unauthorized'));
    renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("shows any other refusal inline, in the API's words, until it is dismissed", async () => {
    vi.mocked(fetchTranscript).mockRejectedValue(new ApiError(404, 'Transcript not found'));
    renderRow(TRANSCRIBED);
    const user = userEvent.setup();

    await user.click(openTranscript());

    expect((await screen.findByRole('alert')).textContent).toBe('Transcript not found');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('says so when the request never reached the API', async () => {
    vi.mocked(fetchTranscript).mockRejectedValue(new TypeError('Failed to fetch'));
    renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The transcript could not be opened. Try again.',
    );
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when the browser refuses the tab, and says why', async () => {
    openTab.mockReturnValue(null);
    renderRow(TRANSCRIBED);

    await userEvent.setup().click(openTranscript());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your browser blocked the new tab. Allow pop-ups for this site, then try again.',
    );
    expect(fetchTranscript).not.toHaveBeenCalled();
  });
});
