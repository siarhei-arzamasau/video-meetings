import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from './meeting-digest-record.fixture';
import { DigestStatus } from './meeting-digest-status';
import { DigestAfterDelete, digestAfterDelete } from './meeting-digest-writes';
import type { RecordingsAfterDelete } from './meeting-digest-writes';

const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;
const { UNCHANGED, CURRENT_AGAIN, REPLACING, CLEARED, WITHDRAWN } = DigestAfterDelete;
const REVISION = 4;

/** What the handler read: by default the second recording was deleted, the first is left. */
const after = (overrides: Partial<RecordingsAfterDelete> = {}): RecordingsAfterDelete => ({
  meetingId: DIGEST_MEETING_ID,
  requestedRevision: REVISION,
  transcribedFileIds: [FIRST_RECORDING_ID],
  replace: true,
  recordingDeleted: true,
  ...overrides,
});

const digest = (status: DigestStatus | null, requestedRevision = REVISION) => ({
  status,
  requestedRevision,
});

const BOTH = [FIRST_RECORDING_ID, SECOND_RECORDING_ID];
const NO_RECORDING = { transcribedFileIds: [] };

/** What a deleted file does to a digest, case by case: the decision, with nothing written. */
describe('digestAfterDelete', () => {
  it.each([
    ['ready', READY],
    ['failed with its earlier content', FAILED],
    ['queued for a replacement', QUEUED],
    ['generating one', GENERATING],
    ['left with no status', null],
  ])(
    'replaces a digest built from the deleted recording while one is left: %s',
    (_case, status) => {
      expect(digestAfterDelete(digest(status), BOTH, after())).toBe(REPLACING);
    },
  );

  it('clears, rather than replaces, a digest built from the deleted recording while the setting is off', () => {
    expect(digestAfterDelete(digest(READY), BOTH, after({ replace: false }))).toBe(CLEARED);
  });

  it.each([
    ['ready', READY, [FIRST_RECORDING_ID]],
    ['failed with nothing stored', FAILED, []],
    ['queued for its first generation', QUEUED, []],
    ['generating', GENERATING, []],
  ])(
    'leaves no digest once no transcribed recording is left: %s',
    (_case, status, sourceFileIds) => {
      for (const replace of [true, false]) {
        expect(
          digestAfterDelete(digest(status), sourceFileIds, after({ ...NO_RECORDING, replace })),
        ).toBe(CLEARED);
      }
    },
  );

  it('leaves the status a request made after the caller looked, and still removes the content', () => {
    // A recording transcribed since: not among those read, and its request moved the revision.
    const requestedSince = digest(QUEUED, REVISION + 1);

    expect(digestAfterDelete(requestedSince, [FIRST_RECORDING_ID], after(NO_RECORDING))).toBe(
      WITHDRAWN,
    );
    expect(digestAfterDelete(requestedSince, [], after(NO_RECORDING))).toBe(UNCHANGED);
  });

  it('has nothing to clear on a row that has no status and no content', () => {
    expect(digestAfterDelete(digest(null), [], after(NO_RECORDING))).toBe(UNCHANGED);
  });

  it('removes content left under a row with no status, when its recording is gone', () => {
    expect(digestAfterDelete(digest(null), [FIRST_RECORDING_ID], after(NO_RECORDING))).toBe(
      WITHDRAWN,
    );
  });

  it('moves only the version when the recording the digest did not cover was the deleted one', () => {
    expect(digestAfterDelete(digest(READY), [FIRST_RECORDING_ID], after())).toBe(CURRENT_AGAIN);
  });

  // What a request made by hand relies on: asked a moment before the delete or let through
  // a moment after it, the row ends `QUEUED` over content that is current either way.
  it.each([
    ['queued', QUEUED],
    ['generating', GENERATING],
  ])('takes no request back from a %s digest whose content is current again', (_case, status) => {
    expect(digestAfterDelete(digest(status), [FIRST_RECORDING_ID], after())).toBe(CURRENT_AGAIN);
  });

  it.each([
    ['the deleted file was not a transcribed recording', after({ recordingDeleted: false })],
    ['another recording is still not covered', after({ transcribedFileIds: BOTH })],
  ])('changes nothing about a digest that was not built from it when %s', (_case, read) => {
    expect(digestAfterDelete(digest(READY), [FIRST_RECORDING_ID], read)).toBe(UNCHANGED);
  });

  it('changes nothing about a digest with no content while a recording is left', () => {
    for (const status of [QUEUED, GENERATING, FAILED, null]) {
      expect(digestAfterDelete(digest(status), [], after())).toBe(UNCHANGED);
    }
  });
});
