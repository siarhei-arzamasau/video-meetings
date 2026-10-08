import type { MeetingFile } from '@repo/shared';
import { meetingFileTranscriptionTimeLimitMessage } from '@repo/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileRow } from './file-row';

const RECORDING: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
};

const TRANSCRIBED: MeetingFile = {
  ...RECORDING,
  transcriptionStatus: 'transcribed',
  transcriptPath: '/meetings/m1/files/f1/transcript',
};

/** Failed on the time limit: the one failure a retry would only repeat. */
const OUT_OF_TIME: MeetingFile = {
  ...RECORDING,
  transcriptionStatus: 'failed',
  transcriptionFailureReason: meetingFileTranscriptionTimeLimitMessage(720),
};

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
      onUnauthorized={vi.fn()}
    />,
  );
}

const openTranscript = (): HTMLElement => screen.getByRole('link', { name: /Open transcript/ });

afterEach(() => {
  cleanup();
});

/** What the row shows for each status. What a press on the link does is the file beside this. */
describe('the transcription element', () => {
  it.each<[string, Partial<MeetingFile>, string | null]>([
    ['a queued recording', { transcriptionStatus: 'queued' }, 'Queued for transcription'],
    ['a recording being transcribed', { transcriptionStatus: 'transcribing' }, 'Transcribing…'],
    ['a failed transcription', { transcriptionStatus: 'failed' }, 'Transcription failed'],
    ['a recording that was never queued', {}, null],
    ['a PDF', { name: 'deck.pdf', contentType: 'application/pdf' }, null],
  ])('for %s', (_case, overrides, label) => {
    renderRow({ ...RECORDING, ...overrides });

    const shown = ['Queued for transcription', 'Transcribing…', 'Transcription failed'].filter(
      (text) => screen.queryByText(text) !== null,
    );

    expect(shown).toEqual(label === null ? [] : [label]);
    expect(screen.queryByRole('link', { name: /Open transcript/ })).toBeNull();
    // The file is ready whatever its transcription is doing.
    expect(screen.getByRole('button', { name: 'Download' })).toBeDefined();
  });

  it('offers the transcript once there is one, and says where it opens', () => {
    renderRow(TRANSCRIBED);

    expect(openTranscript().textContent).toBe('Open transcript (opens in a new tab)');
    expect(screen.queryByText('Transcribing…')).toBeNull();
  });

  it('gives the reason of a failure to whoever reaches the chip', async () => {
    renderRow(OUT_OF_TIME);

    await userEvent.setup().tab();

    expect(
      await screen.findByText(/^Transcription took longer than the 12-minute limit\./),
    ).toBeDefined();
  });

  it('offers no Retry beside that failure, even to someone who may retry the others', () => {
    renderRow(OUT_OF_TIME);

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
