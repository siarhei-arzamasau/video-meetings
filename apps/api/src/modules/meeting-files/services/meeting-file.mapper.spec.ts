import { MAX_MEETING_FILE_NAME_LENGTH, MEETING_FILE_TRANSCRIPTION_STATUSES } from '@repo/shared';

import {
  normaliseFileName,
  storageKeyOf,
  thumbnailKeyOf,
  toMeetingFile,
  transcriptKeyOf,
} from './meeting-file.mapper';
import { buildMeetingFileRecord } from './meeting-file-record.fixture';
import { TranscriptionStatus } from './meeting-file-transcription-status';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

const RECORD = buildMeetingFileRecord({
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: UPLOADER_ID,
  size: 1234,
  checksum: 'sha',
});

describe('toMeetingFile', () => {
  it('maps the base fields and omits everything the worker owns', () => {
    expect(toMeetingFile(RECORD)).toEqual({
      id: FILE_ID,
      meetingId: MEETING_ID,
      uploaderId: UPLOADER_ID,
      name: 'deck.pdf',
      contentType: 'application/pdf',
      size: 1234,
      status: 'uploaded',
      createdAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('carries failureReason only when failed', () => {
    expect(toMeetingFile({ ...RECORD, status: 'failed', failureReason: 'Nope' })).toMatchObject({
      failureReason: 'Nope',
    });
    // A reason left behind by a retry must not surface on a row that is no longer failed.
    expect(toMeetingFile({ ...RECORD, status: 'ready', failureReason: 'Nope' })).not.toHaveProperty(
      'failureReason',
    );
    expect(toMeetingFile({ ...RECORD, status: 'failed', failureReason: null })).not.toHaveProperty(
      'failureReason',
    );
  });

  it('derives thumbnailPath from the ids when a thumbnail key is set', () => {
    expect(
      toMeetingFile({ ...RECORD, thumbnailKey: `${MEETING_ID}/${FILE_ID}.thumb.webp` }),
    ).toMatchObject({ thumbnailPath: `/meetings/${MEETING_ID}/files/${FILE_ID}/thumbnail` });
  });

  it('derives transcriptPath from the ids when a transcript key is set', () => {
    expect(
      toMeetingFile({ ...RECORD, transcriptKey: `${MEETING_ID}/${FILE_ID}.transcript.txt` }),
    ).toMatchObject({ transcriptPath: `/meetings/${MEETING_ID}/files/${FILE_ID}/transcript` });
  });

  it('renders processedAt as an ISO instant when set', () => {
    expect(
      toMeetingFile({ ...RECORD, processedAt: new Date('2026-09-01T10:00:01.000Z') }),
    ).toMatchObject({ processedAt: '2026-09-01T10:00:01.000Z' });
  });

  describe('the transcription status', () => {
    it('is absent for a row that has none, reason and all', () => {
      const file = toMeetingFile({ ...RECORD, transcriptionFailureReason: 'Left behind' });

      expect(file).not.toHaveProperty('transcriptionStatus');
      expect(file).not.toHaveProperty('transcriptionFailureReason');
    });

    it.each([
      [TranscriptionStatus.QUEUED, 'queued'],
      [TranscriptionStatus.TRANSCRIBING, 'transcribing'],
      [TranscriptionStatus.TRANSCRIBED, 'transcribed'],
      [TranscriptionStatus.FAILED, 'failed'],
    ] as const)('translates the stored %s to the wire\u2019s %s', (stored, wire) => {
      expect(toMeetingFile({ ...RECORD, transcriptionStatus: stored })).toMatchObject({
        transcriptionStatus: wire,
      });
    });

    it('covers the whole shared vocabulary, so no stored status is left without a word', () => {
      const translated = Object.values(TranscriptionStatus).map(
        (stored) => toMeetingFile({ ...RECORD, transcriptionStatus: stored }).transcriptionStatus,
      );

      expect(translated.toSorted()).toEqual([...MEETING_FILE_TRANSCRIPTION_STATUSES].toSorted());
    });

    it('carries the reason only when the transcription failed', () => {
      const failed = { ...RECORD, transcriptionFailureReason: 'Nope' };

      expect(
        toMeetingFile({ ...failed, transcriptionStatus: TranscriptionStatus.FAILED }),
      ).toMatchObject({ transcriptionStatus: 'failed', transcriptionFailureReason: 'Nope' });
      // A reason left behind by a retry must not surface on a transcription that is queued again.
      expect(
        toMeetingFile({ ...failed, transcriptionStatus: TranscriptionStatus.QUEUED }),
      ).not.toHaveProperty('transcriptionFailureReason');
      expect(
        toMeetingFile({
          ...RECORD,
          transcriptionStatus: TranscriptionStatus.FAILED,
          transcriptionFailureReason: null,
        }),
      ).not.toHaveProperty('transcriptionFailureReason');
    });

    it('is independent of the file\u2019s own status and reason', () => {
      const file = toMeetingFile({
        ...RECORD,
        status: 'ready',
        failureReason: 'A file reason',
        transcriptionStatus: TranscriptionStatus.FAILED,
        transcriptionFailureReason: 'A transcription reason',
      });

      expect(file).toMatchObject({
        status: 'ready',
        transcriptionStatus: 'failed',
        transcriptionFailureReason: 'A transcription reason',
      });
      expect(file).not.toHaveProperty('failureReason');
    });

    it('never lets the claim\u2019s count or lease out', () => {
      const file = toMeetingFile({
        ...RECORD,
        transcriptionStatus: TranscriptionStatus.TRANSCRIBING,
        transcriptionAttempts: 2,
        transcriptionLeasedUntil: new Date(),
      });

      expect(file).not.toHaveProperty('transcriptionAttempts');
      expect(file).not.toHaveProperty('transcriptionLeasedUntil');
    });
  });
});

describe('storage keys', () => {
  it('are the two ids, and the thumbnail is the key with a suffix', () => {
    expect(storageKeyOf(MEETING_ID, FILE_ID)).toBe(`${MEETING_ID}/${FILE_ID}`);
    expect(thumbnailKeyOf(`${MEETING_ID}/${FILE_ID}`)).toBe(`${MEETING_ID}/${FILE_ID}.thumb.webp`);
  });

  it('gives the transcript the key with a suffix of its own', () => {
    expect(transcriptKeyOf(`${MEETING_ID}/${FILE_ID}`)).toBe(
      `${MEETING_ID}/${FILE_ID}.transcript.txt`,
    );
  });
});

describe('normaliseFileName', () => {
  it('trims surrounding whitespace', () => {
    expect(normaliseFileName('  deck.pdf  ')).toBe('deck.pdf');
  });

  it('keeps non-ASCII names', () => {
    expect(normaliseFileName('отчёт.pdf')).toBe('отчёт.pdf');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'a'.repeat(MAX_MEETING_FILE_NAME_LENGTH + 1)],
    ['a forward slash', 'a/b.pdf'],
    ['a backslash', 'a\\b.pdf'],
    ['a parent reference', '../b.pdf'],
    ['a NUL byte', `a${String.fromCodePoint(0)}b.pdf`],
    ['a newline', 'a\nb.pdf'],
    ['DEL', `a${String.fromCodePoint(0x7f)}b.pdf`],
  ])('rejects %s', (_description, raw) => {
    expect(normaliseFileName(raw)).toBeNull();
  });

  it('accepts a name of exactly the maximum length', () => {
    const name = 'a'.repeat(MAX_MEETING_FILE_NAME_LENGTH);

    expect(normaliseFileName(name)).toBe(name);
  });
});
