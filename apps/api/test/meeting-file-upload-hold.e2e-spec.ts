import { MeetingFileUploadHoldRepository } from '../src/modules/meeting-files/services/meeting-file-upload-hold.repository';
import { MeetingFileUploadRepository } from '../src/modules/meeting-files/services/meeting-file-upload.repository';
import { useApiSuite } from './utils/api-suite';
import { EMAIL } from './utils/fixtures';
import { insertMeetingFileUploadRow } from './utils/meeting-file-uploads-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';

const LEASE_SECONDS = 60;

/** Long enough for a statement that is not blocked to have finished many times over. */
const SETTLE_MS = 300;

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** A promise the test settles when it chooses. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** Every write a test has left unfinished, so `afterEach` can end it. */
const unfinished: Array<() => void> = [];

/** A write the test finishes when it chooses, and can tell has begun. */
function controlledWrite(): {
  write: () => Promise<void>;
  begun: Promise<void>;
  finish: () => void;
} {
  const begun = deferred();
  const finished = deferred();

  unfinished.push(finished.resolve);

  return {
    write: () => {
      begun.resolve();

      return finished.promise;
    },
    begun: begun.promise,
    finish: finished.resolve,
  };
}

/**
 * A chunk is moved into place while its session's row is held. Without the hold, an abort and
 * the worker's purge could both finish while the chunk was still on its way to the disk — and
 * the chunk then landed in a tree that had been removed and marked purged, where nothing
 * looks again. These hold the order: whatever ends a session waits for a write in flight.
 */
describe('a session cannot end while a chunk is being written into it', () => {
  const suite = useApiSuite();

  const holds = (): MeetingFileUploadHoldRepository =>
    suite.app().get(MeetingFileUploadHoldRepository);
  const uploads = (): MeetingFileUploadRepository => suite.app().get(MeetingFileUploadRepository);

  // A test that fails before it finishes its write leaves a transaction holding the row, and
  // the next test's cleanup would wait a minute for it. Finishing twice is harmless.
  afterEach(() => {
    for (const finish of unfinished.splice(0)) {
      finish();
    }
  });

  const openSession = async (expiresAt?: Date): Promise<string> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return insertMeetingFileUploadRow(suite.prisma(), {
      meeting_id: meeting.id,
      uploader_id: host.id,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    });
  };

  it('makes an abort wait for the write, so the purge it leads to comes after the chunk', async () => {
    const uploadId = await openSession();
    const { write, begun, finish } = controlledWrite();
    const order: string[] = [];

    const held = holds().whileLive(uploadId, async () => {
      await write();
      order.push('chunk written');
    });
    await begun;

    const aborting = uploads()
      .expire(uploadId)
      .then((ended) => {
        order.push('session ended');

        return ended;
      });
    await pause(SETTLE_MS);

    // Unheld, the abort has finished by now and the worker has a session to purge.
    expect(order).toEqual([]);
    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toBeNull();

    finish();

    await expect(held).resolves.toBe(true);
    await expect(aborting).resolves.toBe(true);
    expect(order).toEqual(['chunk written', 'session ended']);
    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toMatchObject({ id: uploadId });
  });

  it('keeps the worker from claiming a session that expires during the write', async () => {
    const uploadId = await openSession(new Date(Date.now() + 1_000));
    const { write, begun, finish } = controlledWrite();

    const held = holds().whileLive(uploadId, write);
    await begun;
    await pause(1_500);

    // Expired by now, and still not the worker's: the claim passes over a held row.
    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toBeNull();

    finish();
    await expect(held).resolves.toBe(true);

    await expect(uploads().claimExpired(LEASE_SECONDS)).resolves.toMatchObject({ id: uploadId });
  });

  it('runs nothing for a session that has already ended', async () => {
    const uploadId = await openSession();
    const write = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);

    await uploads().expire(uploadId);

    await expect(holds().whileLive(uploadId, write)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('lets two chunks of one session be written side by side', async () => {
    const uploadId = await openSession();
    const first = controlledWrite();
    const second = controlledWrite();

    const holdingFirst = holds().whileLive(uploadId, first.write);
    const holdingSecond = holds().whileLive(uploadId, second.write);

    // Both have begun before either has finished.
    await Promise.all([first.begun, second.begun]);

    first.finish();
    second.finish();

    await expect(Promise.all([holdingFirst, holdingSecond])).resolves.toEqual([true, true]);
  });
});
