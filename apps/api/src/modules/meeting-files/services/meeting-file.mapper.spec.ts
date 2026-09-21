import { MAX_MEETING_FILE_NAME_LENGTH } from '@repo/shared';

import {
  MeetingFileRecord,
  normaliseFileName,
  storageKeyOf,
  thumbnailKeyOf,
  toMeetingFile,
  transcriptKeyOf,
} from './meeting-file.mapper';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

const RECORD: MeetingFileRecord = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: UPLOADER_ID,
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 1234,
  storageKey: `${MEETING_ID}/${FILE_ID}`,
  checksum: 'sha',
  thumbnailKey: null,
  transcriptKey: null,
  status: 'uploaded',
  failureReason: null,
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  processedAt: null,
  deletedAt: null,
  purgedAt: null,
};

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
