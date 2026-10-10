import { MEETING_DIGEST_ACTIONS } from '@repo/shared';

import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
  buildMeetingDigestRecord,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { toMeetingDigest } from './meeting-digest.mapper';
import type { MeetingDigestRecord } from './meeting-digest.mapper';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;

const ON = true;
const OFF = false;

/** A row whose generation never stored anything, or whose content a delete removed. */
const WITHOUT_CONTENT = { summary: null, generatedAt: null, sources: [] };

/** What the digest offers with `transcribedFileIds` transcribed now, and the setting as given. */
const actionOf = (
  record: MeetingDigestRecord | null,
  transcribedFileIds: string[],
  generationEnabled = ON,
): string | undefined =>
  toMeetingDigest(DIGEST_MEETING_ID, record, transcribedFileIds, new Map(), generationEnabled)
    .availableAction;

/**
 * `availableAction`: that a failed digest may be retried. The retry route refuses exactly
 * where this is absent, because both ask `requestabilityFor` as a retry.
 */
describe('toMeetingDigest, the action a digest offers', () => {
  it('names only actions of the shared vocabulary', () => {
    expect(MEETING_DIGEST_ACTIONS).toEqual(['retry']);
  });

  describe('a digest that is owed and has not failed', () => {
    // Each of these is the catch-up's to ask for, at the next boot, and nobody's to ask
    // for by hand: nothing is offered, and the route answers 409.
    it('offers nothing for a transcribed recording of a meeting that never had a digest', () => {
      expect(toMeetingDigest(DIGEST_MEETING_ID, null, [FIRST_RECORDING_ID], new Map(), ON)).toEqual(
        { meetingId: DIGEST_MEETING_ID, version: 0 },
      );
    });

    it.each([
      ['no status', null],
      ['a status of ready', READY],
    ] as const)('offers nothing for a row with %s and nothing stored under it', (_what, status) => {
      const record = buildMeetingDigestRecord({ status, ...WITHOUT_CONTENT });

      expect(actionOf(record, [FIRST_RECORDING_ID])).toBeUndefined();
    });

    it('offers nothing for a digest that is out of date with nothing queued', () => {
      const digest = toMeetingDigest(
        DIGEST_MEETING_ID,
        buildMeetingDigestRecord(),
        [FIRST_RECORDING_ID, SECOND_RECORDING_ID],
        new Map(),
        ON,
      );

      // Still readable, and marked: the recording it lacks was transcribed with the setting off.
      expect(digest).toMatchObject({ status: 'ready', content: { outOfDate: true } });
      expect(digest).not.toHaveProperty('availableAction');
    });

    it('offers nothing for a digest that lost a recording nothing has reacted to yet', () => {
      const digest = toMeetingDigest(
        DIGEST_MEETING_ID,
        buildMeetingDigestRecord(),
        [SECOND_RECORDING_ID],
        new Map(),
        ON,
      );

      expect(digest).not.toHaveProperty('content');
      expect(digest).not.toHaveProperty('availableAction');
    });
  });

  it('offers nothing for a digest that covers every transcribed recording', () => {
    expect(actionOf(buildMeetingDigestRecord(), [FIRST_RECORDING_ID])).toBeUndefined();
    // A cleared status changes nothing about that: the content is what is current.
    expect(
      actionOf(buildMeetingDigestRecord({ status: null }), [FIRST_RECORDING_ID]),
    ).toBeUndefined();
  });

  it('offers nothing for a meeting with no transcribed recording', () => {
    expect(actionOf(null, [])).toBeUndefined();
    expect(actionOf(buildMeetingDigestRecord({ status: null, ...WITHOUT_CONTENT }), [])).toBe(
      undefined,
    );
  });

  describe('retry', () => {
    it('is offered for a failed digest, with or without an earlier one still readable', () => {
      const failed = { status: FAILED, failureReason: 'The digest could not be generated.' };

      expect(
        actionOf(buildMeetingDigestRecord({ ...failed, ...WITHOUT_CONTENT }), [FIRST_RECORDING_ID]),
      ).toBe('retry');
      expect(
        actionOf(buildMeetingDigestRecord(failed), [FIRST_RECORDING_ID, SECOND_RECORDING_ID]),
      ).toBe('retry');
      // Failed is what the latest generation was, whatever the content under it covers.
      expect(actionOf(buildMeetingDigestRecord(failed), [FIRST_RECORDING_ID])).toBe('retry');
    });

    it('is not offered for a failed digest whose meeting has no transcribed recording left', () => {
      const record = buildMeetingDigestRecord({ status: FAILED, ...WITHOUT_CONTENT });

      expect(actionOf(record, [])).toBeUndefined();
    });
  });

  it.each([[QUEUED], [GENERATING]] as const)(
    'offers nothing while the digest is %s, whatever is stored under it',
    (status) => {
      const recordings = [FIRST_RECORDING_ID, SECOND_RECORDING_ID];

      expect(actionOf(buildMeetingDigestRecord({ status }), recordings)).toBeUndefined();
      expect(
        actionOf(buildMeetingDigestRecord({ status, ...WITHOUT_CONTENT }), recordings),
      ).toBeUndefined();
    },
  );

  it.each([
    ['a meeting that never had a digest', null],
    ['a failed digest', buildMeetingDigestRecord({ status: FAILED })],
    ['an out-of-date digest', buildMeetingDigestRecord()],
    ['a row with nothing stored', buildMeetingDigestRecord({ status: null, ...WITHOUT_CONTENT })],
  ] as const)('offers nothing for %s while the setting is off', (_what, record) => {
    const digest = toMeetingDigest(
      DIGEST_MEETING_ID,
      record,
      [FIRST_RECORDING_ID, SECOND_RECORDING_ID],
      new Map(),
      OFF,
    );

    // Absent, not `undefined`: the JSON matches the shared interface exactly.
    expect(digest).not.toHaveProperty('availableAction');
  });
});
