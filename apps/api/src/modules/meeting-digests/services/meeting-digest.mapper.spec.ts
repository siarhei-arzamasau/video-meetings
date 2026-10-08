import { MEETING_DIGEST_STATUSES } from '@repo/shared';

import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { toMeetingDigest } from './meeting-digest.mapper';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;

const CONTENT = {
  summary: 'The team reviewed the engine and agreed to ship on Friday.',
  actionItems: [
    {
      id: 'item-1',
      description: 'Send the release notes.',
      owner: { kind: 'name', name: 'Grace' },
    },
    { id: 'item-2', description: 'Book the review room.' },
  ],
  decisions: [{ id: 'decision-1', description: 'Ship on Friday.' }],
  generatedAt: '2026-10-08T09:00:00.000Z',
  outOfDate: false,
};

describe('toMeetingDigest', () => {
  it('answers a meeting that never had a digest with version 0 and nothing else', () => {
    expect(toMeetingDigest(DIGEST_MEETING_ID, null, [FIRST_RECORDING_ID])).toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 0,
    });
  });

  it('maps a ready digest: the wire status, the content in order, and no failure reason', () => {
    const digest = toMeetingDigest(DIGEST_MEETING_ID, buildMeetingDigestRecord(), [
      FIRST_RECORDING_ID,
    ]);

    expect(digest).toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 3,
      status: 'ready',
      content: CONTENT,
    });
  });

  it.each([
    [QUEUED, 'queued'],
    [GENERATING, 'generating'],
    [READY, 'ready'],
    [FAILED, 'failed'],
  ] as const)('spells %s as %s, a word of the shared vocabulary', (stored, wire) => {
    const digest = toMeetingDigest(
      DIGEST_MEETING_ID,
      buildMeetingDigestRecord({ status: stored }),
      [],
    );

    expect(digest.status).toBe(wire);
    expect(MEETING_DIGEST_STATUSES).toContain(digest.status);
  });

  it('leaves the status out of a digest that has none, and keeps its version', () => {
    const record = buildMeetingDigestRecord({ status: null, summary: null, generatedAt: null });
    const digest = toMeetingDigest(DIGEST_MEETING_ID, record, []);

    expect(digest).toEqual({ meetingId: DIGEST_MEETING_ID, version: 3 });
  });

  it('gives the reason only while the digest is failed', () => {
    const reason = 'The digest could not be generated.';
    const failed = buildMeetingDigestRecord({ status: FAILED, failureReason: reason });
    // A reason left on a row that was queued again must not show beside the new status.
    const requeued = buildMeetingDigestRecord({ status: QUEUED, failureReason: reason });

    expect(toMeetingDigest(DIGEST_MEETING_ID, failed, [])).toMatchObject({
      status: 'failed',
      failureReason: reason,
    });
    expect(toMeetingDigest(DIGEST_MEETING_ID, requeued, [])).not.toHaveProperty('failureReason');
  });

  it('keeps the stored content beside a failed replacement, and beside a queued one', () => {
    for (const status of [FAILED, QUEUED, GENERATING]) {
      const digest = toMeetingDigest(DIGEST_MEETING_ID, buildMeetingDigestRecord({ status }), [
        FIRST_RECORDING_ID,
      ]);

      expect(digest.content).toEqual(CONTENT);
    }
  });

  it('has no content before a generation has stored one', () => {
    const record = buildMeetingDigestRecord({
      status: GENERATING,
      summary: null,
      generatedAt: null,
      actionItems: [],
      decisions: [],
      sources: [],
    });

    expect(toMeetingDigest(DIGEST_MEETING_ID, record, [FIRST_RECORDING_ID])).toEqual({
      meetingId: DIGEST_MEETING_ID,
      version: 3,
      status: 'generating',
    });
  });

  describe('the two rules that follow the recordings', () => {
    const fromBoth = buildMeetingDigestRecord({
      sources: [{ meetingFileId: FIRST_RECORDING_ID }, { meetingFileId: SECOND_RECORDING_ID }],
    });

    it('withholds content one of whose recordings is no longer transcribed', () => {
      // Deleted, and so no longer among the meeting's transcribed recordings: what was said
      // in it must not stay readable through the digest.
      const digest = toMeetingDigest(DIGEST_MEETING_ID, fromBoth, [FIRST_RECORDING_ID]);

      expect(digest).toEqual({ meetingId: DIGEST_MEETING_ID, version: 3, status: 'ready' });
    });

    it('withholds content when no recording is left at all', () => {
      expect(toMeetingDigest(DIGEST_MEETING_ID, fromBoth, [])).not.toHaveProperty('content');
    });

    it('marks content out of date when a transcribed recording is not among its sources', () => {
      const digest = toMeetingDigest(DIGEST_MEETING_ID, buildMeetingDigestRecord(), [
        FIRST_RECORDING_ID,
        SECOND_RECORDING_ID,
      ]);

      expect(digest.content).toEqual({ ...CONTENT, outOfDate: true });
    });

    it('is current when the sources and the transcribed recordings are the same set', () => {
      const digest = toMeetingDigest(DIGEST_MEETING_ID, fromBoth, [
        SECOND_RECORDING_ID,
        FIRST_RECORDING_ID,
      ]);

      expect(digest.content?.outOfDate).toBe(false);
    });
  });

  it('orders the lists by position, whatever order the rows were loaded in', () => {
    const record = buildMeetingDigestRecord({
      actionItems: [
        { id: 'b', position: 1, description: 'Second.', ownerName: null },
        { id: 'a', position: 0, description: 'First.', ownerName: null },
      ],
      decisions: [
        { id: 'd', position: 1, description: 'Later.' },
        { id: 'c', position: 0, description: 'Earlier.' },
      ],
    });
    const { content } = toMeetingDigest(DIGEST_MEETING_ID, record, [FIRST_RECORDING_ID]);

    expect(content?.actionItems.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(content?.decisions.map(({ id }) => id)).toEqual(['c', 'd']);
  });

  it('exposes nothing the worker owns, and nothing a generation cost', () => {
    const record = {
      ...buildMeetingDigestRecord(),
      attempts: 2,
      leasedUntil: new Date(),
      requestedRevision: 7,
    };
    const digest = toMeetingDigest(DIGEST_MEETING_ID, record, [FIRST_RECORDING_ID]);

    expect(Object.keys(digest).toSorted()).toEqual(['content', 'meetingId', 'status', 'version']);
  });
});
