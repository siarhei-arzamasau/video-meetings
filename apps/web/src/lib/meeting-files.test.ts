import type { MeetingFile } from '@repo/shared';
import {
  MAX_CHUNKED_MEETING_FILE_SIZE_BYTES,
  MAX_MEETING_FILE_SIZE_BYTES,
  MEETING_FILE_ACCEPT,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

import {
  acceptAttribute,
  applyFileEvent,
  formatFileSize,
  isChunkedUpload,
  isProcessing,
  sortNewestFirst,
  statusPresentation,
  validateFileBeforeUpload,
} from './meeting-files';

const file = (overrides: Partial<MeetingFile>): MeetingFile => ({
  id: 'a',
  meetingId: 'm',
  uploaderId: 'u',
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  status: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [329, '329 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [11_262, '11 KB'],
    [1_258_291, '1.2 MB'],
    [MAX_MEETING_FILE_SIZE_BYTES, '100 MB'],
    [3 * 1024 ** 3, '3 GB'],
  ])('renders %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it('renders nothing for a value that is not a size', () => {
    expect(formatFileSize(-1)).toBe('');
    expect(formatFileSize(Number.NaN)).toBe('');
  });
});

describe('statusPresentation', () => {
  it('collapses uploaded and processing into one chip', () => {
    expect(statusPresentation(file({ status: 'uploaded' }))).toEqual({ kind: 'processing' });
    expect(statusPresentation(file({ status: 'processing' }))).toEqual({ kind: 'processing' });
  });

  it('shows nothing for ready', () => {
    expect(statusPresentation(file({ status: 'ready' }))).toEqual({ kind: 'ready' });
  });

  it('carries the failure reason, with the generic copy as the fallback', () => {
    expect(statusPresentation(file({ status: 'failed', failureReason: 'Too big' }))).toEqual({
      kind: 'failed',
      reason: 'Too big',
    });
    expect(statusPresentation(file({ status: 'failed' }))).toEqual({
      kind: 'failed',
      reason: 'Processing failed. You can still download the file.',
    });
  });
});

describe('validateFileBeforeUpload', () => {
  it('accepts an allow-listed extension within the cap', () => {
    expect(validateFileBeforeUpload({ name: 'deck.pdf', size: 10 })).toBeNull();
    expect(validateFileBeforeUpload({ name: 'NOTES.MD', size: 10 })).toBeNull();
  });

  it('rejects over the chunked cap with the size copy, before anything else', () => {
    expect(
      validateFileBeforeUpload({
        name: 'page.html',
        size: MAX_CHUNKED_MEETING_FILE_SIZE_BYTES + 1,
      }),
    ).toBe('Files must be 1 GB or smaller.');
  });

  it('accepts a file over the single-request cap: it is chunked, not rejected', () => {
    expect(
      validateFileBeforeUpload({ name: 'big.mp4', size: MAX_MEETING_FILE_SIZE_BYTES + 1 }),
    ).toBeNull();
  });

  it('accepts exactly the chunked cap', () => {
    expect(
      validateFileBeforeUpload({ name: 'big.mp4', size: MAX_CHUNKED_MEETING_FILE_SIZE_BYTES }),
    ).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateFileBeforeUpload({ name: 'deck.pdf', size: 0 })).toBe('The file is empty');
  });

  it('rejects a type by extension, not by the browser-reported type', () => {
    expect(validateFileBeforeUpload({ name: 'page.html', size: 10 })).toBe(
      'That file type is not supported.',
    );
    expect(validateFileBeforeUpload({ name: 'noextension', size: 10 })).toBe(
      'That file type is not supported.',
    );
  });

  it('rejects a bad name with the name copy', () => {
    expect(validateFileBeforeUpload({ name: '   ', size: 10 })).toBe(
      'The file name must be 1–255 characters and contain no path separators',
    );
    expect(validateFileBeforeUpload({ name: `${'a'.repeat(252)}.pdf`, size: 10 })).toBe(
      'The file name must be 1–255 characters and contain no path separators',
    );
  });
});

describe('acceptAttribute', () => {
  it('is the shared extension list, comma-joined', () => {
    expect(acceptAttribute()).toBe(MEETING_FILE_ACCEPT.join(','));
    expect(acceptAttribute()).toContain('.pdf');
    expect(acceptAttribute()).toContain('.docx');
    expect(acceptAttribute()).not.toContain('.html');
  });
});

describe('isProcessing', () => {
  it('is true while any file is uploaded or processing', () => {
    expect(isProcessing([file({ status: 'ready' }), file({ status: 'uploaded' })])).toBe(true);
    expect(isProcessing([file({ status: 'processing' })])).toBe(true);
  });

  it('is false for ready and failed only, and for an empty list', () => {
    expect(isProcessing([file({ status: 'ready' }), file({ status: 'failed' })])).toBe(false);
    expect(isProcessing([])).toBe(false);
  });
});

describe('applyFileEvent', () => {
  const ready = file({ id: 'a', status: 'ready', createdAt: '2026-09-02T10:00:00.000Z' });
  const other = file({ id: 'b', createdAt: '2026-09-01T10:00:00.000Z' });

  it('replaces a known file where it is, not at the top', () => {
    const processing = { ...other, status: 'processing' as const };

    const files = applyFileEvent([ready, other], processing);

    // The list is newest first; a row that jumped to the top would jump back at the next
    // refetch, which reads as the page losing its place.
    expect(files.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(files[1]).toEqual(processing);
  });

  it('re-sorts an unknown file in rather than prepending it', () => {
    const oldest = file({ id: 'c', createdAt: '2026-08-01T10:00:00.000Z' });

    // Somebody else's upload of an older file lands exactly where a refetch would put it.
    expect(applyFileEvent([ready, other], oldest).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('removes a file the event reports as deleted', () => {
    expect(applyFileEvent([ready, other], { ...other, status: 'deleted' })).toEqual([ready]);
  });

  it('is idempotent for a delete it has already applied', () => {
    const files = [ready];

    // The worker announces the purge after the soft delete, with the same status.
    expect(applyFileEvent(files, { ...other, status: 'deleted' })).toBe(files);
  });

  it('leaves the array it was given alone', () => {
    const files = [ready, other];

    applyFileEvent(files, { ...other, status: 'deleted' });

    expect(files.map(({ id }) => id)).toEqual(['a', 'b']);
  });
});

describe('sortNewestFirst', () => {
  it("orders by createdAt descending, ties on id descending — the API's order", () => {
    const older = file({ id: 'b', createdAt: '2026-09-01T10:00:00.000Z' });
    const tiedLow = file({ id: 'a', createdAt: '2026-09-02T10:00:00.000Z' });
    const tiedHigh = file({ id: 'c', createdAt: '2026-09-02T10:00:00.000Z' });

    expect(sortNewestFirst([older, tiedLow, tiedHigh]).map(({ id }) => id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('returns a new array rather than sorting the one held in state', () => {
    const files = [file({ id: 'a' }), file({ id: 'b' })];
    const sorted = sortNewestFirst(files);

    expect(sorted).not.toBe(files);
    expect(files.map(({ id }) => id)).toEqual(['a', 'b']);
  });
});

describe('isChunkedUpload', () => {
  it('is the single-request cap, exclusive: one byte over goes in chunks', () => {
    expect(isChunkedUpload({ size: MAX_MEETING_FILE_SIZE_BYTES })).toBe(false);
    expect(isChunkedUpload({ size: MAX_MEETING_FILE_SIZE_BYTES + 1 })).toBe(true);
  });
});
