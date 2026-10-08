import type { MeetingFile } from '@repo/shared';
import { MEETING_FILE_TRANSCRIPTION_STATUSES } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { isAwaitingWorker, isProcessing, transcriptionPresentation } from './meeting-files';

/** A recording that is `ready`, which is the only kind of file that carries a transcription. */
const recording = (overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id: 'a',
  meetingId: 'm',
  uploaderId: 'u',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 10,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

describe('transcriptionPresentation', () => {
  it.each<[string, Partial<MeetingFile>, ReturnType<typeof transcriptionPresentation>]>([
    ['a file that was never queued', {}, { kind: 'none' }],
    ['a queued recording', { transcriptionStatus: 'queued' }, { kind: 'queued' }],
    [
      'a recording being worked on',
      { transcriptionStatus: 'transcribing' },
      { kind: 'transcribing' },
    ],
    [
      'a finished transcript',
      { transcriptionStatus: 'transcribed', transcriptPath: '/meetings/m/files/a/transcript' },
      { kind: 'transcribed' },
    ],
    [
      'a failure with the reason the API stored',
      {
        transcriptionStatus: 'failed',
        transcriptionFailureReason: 'Transcription took longer than the 12-minute limit.',
      },
      { kind: 'failed', reason: 'Transcription took longer than the 12-minute limit.' },
    ],
    [
      'a failure that carries no reason',
      { transcriptionStatus: 'failed' },
      // The shared fallback, spelt out: rewording it must fail here rather than pass quietly.
      { kind: 'failed', reason: 'The recording could not be transcribed.' },
    ],
  ])('shows %s', (_case, overrides, expected) => {
    expect(transcriptionPresentation(recording(overrides))).toEqual(expected);
  });

  it('has something to show for every status the contract lists', () => {
    // A fifth status added to `@repo/shared` must not render as an empty row.
    for (const transcriptionStatus of MEETING_FILE_TRANSCRIPTION_STATUSES) {
      expect(transcriptionPresentation(recording({ transcriptionStatus })).kind).toBe(
        transcriptionStatus,
      );
    }
  });

  it('ignores a stale reason on a transcription that is no longer failed', () => {
    expect(
      transcriptionPresentation(
        recording({ transcriptionStatus: 'queued', transcriptionFailureReason: 'Left behind' }),
      ),
    ).toEqual({ kind: 'queued' });
  });
});

describe('isAwaitingWorker', () => {
  it.each<[string, MeetingFile[], boolean]>([
    ['an empty list', [], false],
    ['a file still being processed', [recording({ status: 'uploaded' })], true],
    ['a file in the pipeline', [recording({ status: 'processing' })], true],
    ['a queued recording', [recording({ transcriptionStatus: 'queued' })], true],
    ['a recording being transcribed', [recording({ transcriptionStatus: 'transcribing' })], true],
    ['a transcribed recording', [recording({ transcriptionStatus: 'transcribed' })], false],
    ['a failed transcription', [recording({ transcriptionStatus: 'failed' })], false],
    ['a ready file with no transcription', [recording()], false],
    ['a failed file', [recording({ status: 'failed' })], false],
    [
      'one queued recording among settled files',
      [
        recording({ id: 'a', transcriptionStatus: 'transcribed' }),
        recording({ id: 'b', name: 'deck.pdf', contentType: 'application/pdf' }),
        recording({ id: 'c', transcriptionStatus: 'queued' }),
      ],
      true,
    ],
  ])('for %s', (_case, files, expected) => {
    expect(isAwaitingWorker(files)).toBe(expected);
  });

  it('leaves the processing count alone: a ready recording is not a file being processed', () => {
    // `isProcessing` feeds the section's announcement, which is about the file's own checks.
    expect(isProcessing([recording({ transcriptionStatus: 'transcribing' })])).toBe(false);
  });
});
