import type { MeetingFile } from '@repo/shared';
import { MEETING_FILE_PROCESSING_FAILED_MESSAGE } from '@repo/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileRow } from './file-row';

const FAILED: MeetingFile = {
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'diagram.png',
  contentType: 'image/png',
  size: 3_346,
  status: 'failed',
  failureReason: 'The image could not be read',
  createdAt: '2026-10-01T10:00:00.000Z',
};

function renderRow(file: MeetingFile, canManage = true) {
  return render(
    <FileRow
      token="a-signed-jwt"
      file={file}
      isMine
      canManage={canManage}
      onDelete={vi.fn()}
      onRetried={vi.fn()}
      onStale={vi.fn()}
      onUnauthorized={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
});

/** Why a file failed its checks. Why a transcription did is `file-row.transcription.test.tsx`. */
describe("a failed file's reason", () => {
  it('is written on the row, with nothing to hover or focus first', () => {
    renderRow(FAILED);

    // A tooltip opens on hover or keyboard focus, and a touch screen has neither.
    expect(screen.getByText('The image could not be read')).toBeDefined();
    expect(screen.getByText('Processing failed').closest('[tabindex]')).toBeNull();
  });

  it('is the generic sentence when the API stored none', () => {
    renderRow({ ...FAILED, failureReason: undefined });

    expect(screen.getByText(MEETING_FILE_PROCESSING_FAILED_MESSAGE)).toBeDefined();
  });

  it('is there for someone who may not retry it, too', () => {
    renderRow(FAILED, false);

    expect(screen.getByText('The image could not be read')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('is not written for a file that did not fail', () => {
    // A reason can outlive the failure it described; the status decides, not the field.
    renderRow({ ...FAILED, status: 'ready' });

    expect(screen.queryByText('The image could not be read')).toBeNull();
    expect(screen.queryByText('Processing failed')).toBeNull();
  });
});
