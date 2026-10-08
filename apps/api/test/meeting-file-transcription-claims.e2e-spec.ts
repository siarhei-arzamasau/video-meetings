import { MeetingFileTranscriptionRepository } from '../src/modules/meeting-files/services/meeting-file-transcription.repository';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import {
  QUEUED,
  TRANSCRIBING,
  setMeetingFileTranscriptionState,
} from './utils/meeting-file-transcription-table';
import type { MeetingFileTranscriptionState } from './utils/meeting-file-transcription-table';
import { findMeetingFileRow, insertMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

/** More claimants than rows, and fewer than the connection pool holds, so all are in flight. */
const CLAIMANTS = 8;
const ROWS = 5;
const LEASE_SECONDS = 60;
const MINUTE_MS = 60_000;

/** The ids that were claimed, sorted; a claimant that got nothing adds none. */
const idsOf = (claims: ReadonlyArray<{ id: string } | null>): string[] =>
  claims.flatMap((claim) => (claim === null ? [] : [claim.id])).toSorted();

/**
 * The transcription claim, raced for real against the database, as `meeting-file-claims` does
 * for the file worker's: the unit specs mock Prisma, so this is where the statement's locking
 * and its `WHERE` are what is under test. A recording is transcribed once, not once per
 * replica — which is exactly "no two claimants are handed the same row".
 */
describe('transcription claims under concurrency', () => {
  const suite = useApiSuite();

  const transcriptions = (): MeetingFileTranscriptionRepository =>
    suite.app().get(MeetingFileTranscriptionRepository);

  /** Seeds one file row and puts its transcription in `state`. */
  const seed = async (
    fileStatus: string,
    state: MeetingFileTranscriptionState,
    ids: { meetingId: string; hostId: string },
  ): Promise<string> => {
    const id = await insertMeetingFileRow(suite.prisma(), {
      meeting_id: ids.meetingId,
      uploader_id: ids.hostId,
      content_type: 'audio/mpeg',
      status: fileStatus,
    });

    await setMeetingFileTranscriptionState(suite.prisma(), id, state);

    return id;
  };

  const seedMeeting = async (): Promise<{ meetingId: string; hostId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { hostId: host.id, meetingId: meeting.id };
  };

  it('hands each queued recording to exactly one of several racing workers', async () => {
    const ids = await seedMeeting();
    const seeded = await Promise.all(
      Array.from({ length: ROWS }, () => seed('ready', { transcription_status: QUEUED }, ids)),
    );

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => transcriptions().claimNext(LEASE_SECONDS)),
    );

    expect(idsOf(claims)).toEqual(seeded.toSorted());
    // A claimed row comes back whole and already moved: transcribing, counted once, leased.
    for (const claim of claims.filter((claimed) => claimed !== null)) {
      expect(claim).toMatchObject({
        status: 'ready',
        transcriptionStatus: TRANSCRIBING,
        transcriptionAttempts: 1,
        transcriptionLeasedUntil: expect.any(Date),
      });
    }
  });

  it('claims only what is claimable: ready files, queued or past their lease', async () => {
    const ids = await seedMeeting();
    const lapsed = { transcription_status: TRANSCRIBING, transcription_attempts: 1 };
    const claimable = await Promise.all([
      seed('ready', { transcription_status: QUEUED }, ids),
      seed(
        'ready',
        { ...lapsed, transcription_leased_until: new Date(Date.now() - MINUTE_MS) },
        ids,
      ),
    ]);
    const untouchable = await Promise.all([
      // No status at all: not a recording, or processed while the setting was off.
      seed('ready', {}, ids),
      // Held by a worker whose lease still stands.
      seed(
        'ready',
        { ...lapsed, transcription_leased_until: new Date(Date.now() + MINUTE_MS) },
        ids,
      ),
      // Deleted with a transcription still queued: the claim requires the file to be ready.
      seed('deleted', { transcription_status: QUEUED }, ids),
    ]);

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => transcriptions().claimNext(LEASE_SECONDS)),
    );

    expect(idsOf(claims)).toEqual(claimable.toSorted());
    const rows = await Promise.all(untouchable.map((id) => findMeetingFileRow(suite.prisma(), id)));
    expect(rows.map((row) => row.transcription_attempts)).toEqual([0, 1, 0]);
  });
});
