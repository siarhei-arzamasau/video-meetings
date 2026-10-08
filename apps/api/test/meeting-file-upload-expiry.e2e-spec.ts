import { MeetingFileUploadRepository } from '../src/modules/meeting-files/services/meeting-file-upload.repository';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import { insertMeetingFileUploadRow } from './utils/meeting-file-uploads-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

/** Far more than two clocks on one machine drift apart, so a pass is not a matter of timing. */
const SKEW_MS = 5_000;
const LEASE_SECONDS = 60;

/**
 * Moves this process's clock away from the database's and holds it there. Only `Date` is
 * faked: the timers are the driver's and the test runner's, and must keep running.
 */
const skewClockBy = (milliseconds: number): void => {
  jest.useFakeTimers({
    now: Date.now() + milliseconds,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
};

/**
 * A session is expired by two clocks: the lookups compare its expiry with this process's, the
 * claims with PostgreSQL's `now()`. They are never quite the same clock — the database's is a
 * VM's — so a session that is ended on purpose has to be over by both, at once, whichever of
 * them is ahead. Stamped with one alone it stayed live to the other for as long as they
 * differed, which is what failed "collects an aborted session" once in a few hundred runs.
 */
describe('ending an upload session while the two clocks disagree', () => {
  const suite = useApiSuite();

  const uploads = (): MeetingFileUploadRepository => suite.app().get(MeetingFileUploadRepository);

  const openSession = async (): Promise<{ id: string; meetingId: string; uploaderId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const id = await insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
    });

    return { id, meetingId: meeting.id, uploaderId: host.id };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the worker’s to collect at once when this clock is ahead of the database’s', async () => {
    const { id } = await openSession();
    skewClockBy(SKEW_MS);

    await expect(uploads().expire(id)).resolves.toBe(true);

    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toMatchObject({ id });
  });

  it('can no longer be completed or sent a chunk when this clock is ahead', async () => {
    const { id } = await openSession();
    skewClockBy(SKEW_MS);

    await expect(uploads().expire(id)).resolves.toBe(true);

    await expect(uploads().claimForCompletion(id, LEASE_SECONDS)).resolves.toBeNull();
    await expect(uploads().addReceivedChunk(id, 0)).resolves.toBeNull();
  });

  it('is gone for its owner at once when this clock is behind the database’s', async () => {
    const { id, meetingId, uploaderId } = await openSession();
    skewClockBy(-SKEW_MS);

    await expect(uploads().expire(id)).resolves.toBe(true);

    await expect(uploads().findOwned(meetingId, id, uploaderId)).resolves.toBeNull();
    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toMatchObject({ id });
  });

  it.each([SKEW_MS, -SKEW_MS])('is ended once, with the clock off by %d ms', async (skew) => {
    const { id } = await openSession();
    skewClockBy(skew);

    await expect(uploads().expire(id)).resolves.toBe(true);
    await expect(uploads().expire(id)).resolves.toBe(false);
  });
});
