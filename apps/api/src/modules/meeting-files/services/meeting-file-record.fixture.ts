import type { MeetingFileRecord } from './meeting-file.mapper';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const UPLOADER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A whole stored row for a spec: an uploaded PDF that nothing has claimed, with `overrides`
 * laid over it. A spec names the columns its case is about and takes the rest from here, so
 * a column added to `meeting_files` is one edit in this file rather than one in every spec
 * that needs a record.
 */
export function buildMeetingFileRecord(
  overrides: Partial<MeetingFileRecord> = {},
): MeetingFileRecord {
  return {
    id: FILE_ID,
    meetingId: MEETING_ID,
    uploaderId: UPLOADER_ID,
    name: 'deck.pdf',
    contentType: 'application/pdf',
    size: 10,
    storageKey: `${MEETING_ID}/${FILE_ID}`,
    checksum: null,
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
    transcriptionStatus: null,
    transcriptionFailureReason: null,
    transcriptionAttempts: 0,
    transcriptionLeasedUntil: null,
    ...overrides,
  };
}
