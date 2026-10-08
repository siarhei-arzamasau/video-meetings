import type { MeetingFile } from '@repo/shared';
import {
  MEETING_FILE_STATUSES,
  MEETING_FILE_TRANSCRIPTION_STATUSES,
  meetingFileTranscriptionTimeLimitMessage,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { retryTargetOf } from './meeting-file-retry';

type Row = Pick<MeetingFile, 'status' | 'transcriptionStatus' | 'transcriptionFailureReason'>;

describe('retryTargetOf', () => {
  it.each<[string, Row, ReturnType<typeof retryTargetOf>]>([
    ['a file that failed its checks', { status: 'failed' }, 'file'],
    ['a file waiting for the worker', { status: 'uploaded' }, null],
    ['a file being processed', { status: 'processing' }, null],
    ['a ready file that is not a recording', { status: 'ready' }, null],
    [
      'a ready recording whose transcription failed',
      { status: 'ready', transcriptionStatus: 'failed' },
      'transcription',
    ],
    [
      'a recording that outran the time limit, which a retry would only do again',
      {
        status: 'ready',
        transcriptionStatus: 'failed',
        transcriptionFailureReason: meetingFileTranscriptionTimeLimitMessage(720),
      },
      null,
    ],
    [
      'a recording whose transcription failed for any other stated reason',
      {
        status: 'ready',
        transcriptionStatus: 'failed',
        transcriptionFailureReason: 'The recording could not be transcribed.',
      },
      'transcription',
    ],
    ['a queued recording', { status: 'ready', transcriptionStatus: 'queued' }, null],
    [
      'a recording being transcribed',
      { status: 'ready', transcriptionStatus: 'transcribing' },
      null,
    ],
    ['a transcribed recording', { status: 'ready', transcriptionStatus: 'transcribed' }, null],
  ])('for %s', (_case, row, expected) => {
    expect(retryTargetOf(row)).toBe(expected);
  });

  it('names the file when a row claims both failures, so the row never offers two', () => {
    // The API never writes this: a file that failed its checks was never queued. If one ever
    // arrived, the file is what stands between the recording and any transcription at all.
    expect(retryTargetOf({ status: 'failed', transcriptionStatus: 'failed' })).toBe('file');
  });

  it('retries only what failed, whatever the two statuses are', () => {
    // Every pair the contract can spell, so a status added to either list has an answer here.
    for (const status of MEETING_FILE_STATUSES) {
      for (const transcriptionStatus of [undefined, ...MEETING_FILE_TRANSCRIPTION_STATUSES]) {
        const target = retryTargetOf({
          status,
          ...(transcriptionStatus === undefined ? {} : { transcriptionStatus }),
        });

        expect(target === 'file').toBe(status === 'failed');
        expect(target === 'transcription').toBe(
          status !== 'failed' && transcriptionStatus === 'failed',
        );
      }
    }
  });
});
