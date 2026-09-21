import { MeetingFileUploadRepository } from '../src/modules/meeting-files/services/meeting-file-upload.repository';
import { MeetingFileRepository } from '../src/modules/meeting-files/services/meeting-file.repository';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import { insertMeetingFileUploadRow } from './utils/meeting-file-uploads-table';
import { insertMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

/** More claimants than rows, and fewer than the connection pool holds, so all are in flight. */
const CLAIMANTS = 8;
const ROWS = 5;
const LEASE_SECONDS = 60;

/** The ids that were claimed, sorted; a claimant that got nothing adds none. */
const idsOf = (claims: ReadonlyArray<{ id: string } | null>): string[] =>
  claims.flatMap((claim) => (claim === null ? [] : [claim.id])).toSorted();

/**
 * The claims the worker and a completion take, raced for real against the database.
 *
 * Every unit spec mocks the repositories, so this is the one place their SQL's locking is what
 * is under test. Drop the row lock from a worker claim and racing claimants get the same row —
 * tried: one file came back claimed four times. `SKIP LOCKED` is throughput, not correctness:
 * without it the claimants queue on the first row, Postgres re-checks it once the lock is
 * released, and each still moves on to a row of its own. The assertions hold however the
 * claims interleave, so the spec cannot flake — at worst, a run that serialised them proves
 * less.
 */
describe('claims under concurrency', () => {
  const suite = useApiSuite();

  const seedMeeting = async (): Promise<{ hostId: string; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { hostId: host.id, meetingId: meeting.id };
  };

  it('hands each uploaded file to exactly one of several racing workers', async () => {
    const { hostId, meetingId } = await seedMeeting();
    const seeded = await Promise.all(
      Array.from({ length: ROWS }, () =>
        insertMeetingFileRow(suite.prisma(), { meeting_id: meetingId, uploader_id: hostId }),
      ),
    );
    const files = suite.app().get(MeetingFileRepository);

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => files.claimNext(LEASE_SECONDS)),
    );

    expect(idsOf(claims)).toEqual(seeded.toSorted());
  });

  it('hands each expired session to exactly one of several racing workers', async () => {
    const { hostId, meetingId } = await seedMeeting();
    const seeded = await Promise.all(
      Array.from({ length: ROWS }, () =>
        insertMeetingFileUploadRow(suite.prisma(), {
          meeting_id: meetingId,
          uploader_id: hostId,
          expires_at: new Date(Date.now() - 60_000),
        }),
      ),
    );
    const uploads = suite.app().get(MeetingFileUploadRepository);

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => uploads.claimExpired(LEASE_SECONDS)),
    );

    expect(idsOf(claims)).toEqual(seeded.toSorted());
  });

  it('lets exactly one of several racing completions claim a session', async () => {
    const { hostId, meetingId } = await seedMeeting();
    const sessionId = await insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meetingId,
      uploader_id: hostId,
    });
    const uploads = suite.app().get(MeetingFileUploadRepository);

    const claims = await Promise.all(
      Array.from({ length: CLAIMANTS }, () => uploads.claimForCompletion(sessionId, LEASE_SECONDS)),
    );

    expect(idsOf(claims)).toEqual([sessionId]);
  });
});
