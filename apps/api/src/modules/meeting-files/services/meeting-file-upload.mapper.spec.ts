import {
  chunkCountOf,
  chunkKeyOf,
  chunkLengthOf,
  toMeetingFileUpload,
} from './meeting-file-upload.mapper';
import type { MeetingFileUploadRecord } from './meeting-file-upload.mapper';

const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const RECORD: MeetingFileUploadRecord = {
  id: UPLOAD_ID,
  meetingId: MEETING_ID,
  uploaderId: '22222222-2222-4222-8222-222222222222',
  name: 'recording.mp4',
  size: 20,
  chunkSize: 8,
  chunkCount: 3,
  receivedChunks: [2, 0],
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-19T10:00:00.000Z'),
  expiresAt: new Date('2026-09-20T10:00:00.000Z'),
  purgedAt: null,
};

describe('toMeetingFileUpload', () => {
  it('maps the row to the wire shape, sorted, with nothing the module owns', () => {
    expect(toMeetingFileUpload(RECORD)).toEqual({
      id: UPLOAD_ID,
      meetingId: MEETING_ID,
      name: 'recording.mp4',
      size: 20,
      chunkSize: 8,
      chunkCount: 3,
      receivedChunks: [0, 2],
      createdAt: '2026-09-19T10:00:00.000Z',
      expiresAt: '2026-09-20T10:00:00.000Z',
    });
  });

  it('leaves the record untouched — the sort is on a copy', () => {
    toMeetingFileUpload(RECORD);

    expect(RECORD.receivedChunks).toEqual([2, 0]);
  });
});

describe('the chunk plan', () => {
  it.each([
    [1, 8, 1],
    [8, 8, 1],
    [9, 8, 2],
    [16, 8, 2],
    [17, 8, 3],
  ])('chunkCountOf(%i, %i) is %i', (size, chunkSize, expected) => {
    expect(chunkCountOf(size, chunkSize)).toBe(expected);
  });

  it('gives every chunk but the last the full length, and the last the remainder', () => {
    expect(chunkLengthOf(20, 8, 0)).toBe(8);
    expect(chunkLengthOf(20, 8, 1)).toBe(8);
    expect(chunkLengthOf(20, 8, 2)).toBe(4);
  });

  it('gives a single-chunk file the whole size', () => {
    expect(chunkLengthOf(5, 8, 0)).toBe(5);
  });

  it('gives an exact multiple a full last chunk', () => {
    expect(chunkLengthOf(16, 8, 1)).toBe(8);
  });

  it('keys a chunk under its session and index', () => {
    expect(chunkKeyOf(UPLOAD_ID, 0)).toBe(`uploads/${UPLOAD_ID}/0`);
    expect(chunkKeyOf(UPLOAD_ID, 12)).toBe(`uploads/${UPLOAD_ID}/12`);
  });
});
