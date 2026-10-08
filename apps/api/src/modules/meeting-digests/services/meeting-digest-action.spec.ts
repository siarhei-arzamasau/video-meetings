import { DigestRequestRefusal, isUnderWay, requestabilityOf } from './meeting-digest-action';
import type { DigestStanding } from './meeting-digest-action';
import { FIRST_RECORDING_ID, SECOND_RECORDING_ID } from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;
const { NO_RECORDING, UNDER_WAY, CURRENT } = DigestRequestRefusal;

const FIRST = [FIRST_RECORDING_ID];
const BOTH = [FIRST_RECORDING_ID, SECOND_RECORDING_ID];

/** A digest row with `status`, and content built from `sourceFileIds` — none: nothing stored. */
const standing = (status: DigestStatus | null, sourceFileIds: string[] = []): DigestStanding => ({
  status,
  summary: sourceFileIds.length === 0 ? null : 'The team agreed to ship on Friday.',
  sources: sourceFileIds.map((meetingFileId) => ({ meetingFileId })),
});

const decide = (row: DigestStanding | null, transcribedFileIds: string[]): unknown =>
  requestabilityOf(row, new Set(transcribedFileIds));

const GENERATE = { allowed: true, action: 'generate' };
const RETRY = { allowed: true, action: 'retry' };
const refusedAs = (refusal: DigestRequestRefusal): unknown => ({ allowed: false, refusal });

/**
 * The one rule behind `availableAction` and the request route's 409. The mapper's spec holds
 * the read to it state by state; this one is the rule itself, with the reason for each no.
 */
describe('requestabilityOf', () => {
  it.each([
    ['a meeting with no digest row', null, FIRST],
    ['a row with no status and nothing stored', standing(null), FIRST],
    ['a ready row whose content a delete removed', standing(READY), FIRST],
    ['a digest that does not cover the second recording', standing(READY, FIRST), BOTH],
    ['a digest built from a recording that is gone', standing(READY, BOTH), FIRST],
    ['a cleared digest that does not cover a recording', standing(null, FIRST), BOTH],
  ] as const)('allows Generate for %s', (_what, row, transcribedFileIds) => {
    expect(decide(row, [...transcribedFileIds])).toEqual(GENERATE);
  });

  it('allows Retry for a failed digest, whatever is stored under it', () => {
    expect(decide(standing(FAILED), FIRST)).toEqual(RETRY);
    expect(decide(standing(FAILED, FIRST), BOTH)).toEqual(RETRY);
    // Content that covers everything is the last success; the failure is the latest attempt.
    expect(decide(standing(FAILED, FIRST), FIRST)).toEqual(RETRY);
  });

  it.each([
    ['no row', null],
    ['no status', standing(null)],
    ['a failed digest', standing(FAILED)],
    ['a queued digest', standing(QUEUED)],
    ['a stored digest', standing(READY, FIRST)],
  ] as const)('refuses a meeting with no transcribed recording, with %s', (_what, row) => {
    expect(decide(row, [])).toEqual(refusedAs(NO_RECORDING));
  });

  it.each([[QUEUED], [GENERATING]] as const)(
    'refuses while a generation is %s, out of date or not',
    (status) => {
      expect(decide(standing(status), FIRST)).toEqual(refusedAs(UNDER_WAY));
      expect(decide(standing(status, FIRST), BOTH)).toEqual(refusedAs(UNDER_WAY));
    },
  );

  it('refuses a digest built from exactly the recordings transcribed now', () => {
    expect(decide(standing(READY, FIRST), FIRST)).toEqual(refusedAs(CURRENT));
    expect(decide(standing(READY, BOTH), BOTH.toReversed())).toEqual(refusedAs(CURRENT));
    // A status cleared over content that is still whole: there is nothing to add to it.
    expect(decide(standing(null, FIRST), FIRST)).toEqual(refusedAs(CURRENT));
  });

  it('does not take sources for content: a summary is what says a digest is stored', () => {
    const withoutSummary = { ...standing(READY, FIRST), summary: null };

    expect(decide(withoutSummary, FIRST)).toEqual(GENERATE);
  });
});

describe('isUnderWay', () => {
  it('is true of a queued or generating digest and of nothing else', () => {
    expect([QUEUED, GENERATING].map(isUnderWay)).toEqual([true, true]);
    expect([READY, FAILED, null, undefined].map(isUnderWay)).toEqual([false, false, false, false]);
  });
});
