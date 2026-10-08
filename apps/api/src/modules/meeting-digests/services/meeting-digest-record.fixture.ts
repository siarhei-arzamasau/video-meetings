import { DigestStatus } from './meeting-digest-status';
import type { MeetingDigestRecord } from './meeting-digest.mapper';

export const DIGEST_ID = '66666666-6666-4666-8666-666666666666';
export const DIGEST_MEETING_ID = '44444444-4444-4444-8444-444444444444';
export const FIRST_RECORDING_ID = '55555555-5555-4555-8555-555555555551';
export const SECOND_RECORDING_ID = '55555555-5555-4555-8555-555555555552';

/**
 * A stored digest with its content, as the read loads it: ready, generated from one
 * recording, with one action item that names its owner, one that names nobody, and one
 * decision. A spec names only what its case is about.
 */
export function buildMeetingDigestRecord(
  overrides: Partial<MeetingDigestRecord> = {},
): MeetingDigestRecord {
  return {
    id: DIGEST_ID,
    meetingId: DIGEST_MEETING_ID,
    status: DigestStatus.READY,
    failureReason: null,
    version: 3,
    summary: 'The team reviewed the engine and agreed to ship on Friday.',
    generatedAt: new Date('2026-10-08T09:00:00.000Z'),
    actionItems: [
      {
        id: 'item-1',
        position: 0,
        description: 'Send the release notes.',
        ownerName: 'Grace',
        ownerId: null,
      },
      {
        id: 'item-2',
        position: 1,
        description: 'Book the review room.',
        ownerName: null,
        ownerId: null,
      },
    ],
    decisions: [{ id: 'decision-1', position: 0, description: 'Ship on Friday.' }],
    sources: [{ meetingFileId: FIRST_RECORDING_ID }],
    ...overrides,
  };
}
