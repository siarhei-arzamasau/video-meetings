import { Logger } from '@nestjs/common';

import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import {
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from '../services/meeting-digest-record.fixture';
import { MeetingDigestWorker } from './meeting-digest-worker';
import {
  CLAIMED,
  GENERATED,
  HELD,
  LEASE,
  TRANSCRIBED,
  buildDigestWorker,
  digestWorkerDoubles,
  resetDigestWorkerDoubles,
} from './meeting-digest-worker.fixture';

const GENERIC = 'The digest could not be generated.';

/**
 * The worker beside a delete: an answer is stored only if every recording it was built from
 * is still transcribed when it arrives, and each write that lands is announced.
 */
describe('MeetingDigestWorker: recordings deleted while it works, and what it announces', () => {
  const doubles = digestWorkerDoubles();
  const { complete, fail, release, clear, execute, transcribed, generate, announce } = doubles;
  const { recheckStored } = doubles;
  let worker: MeetingDigestWorker;

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    resetDigestWorkerDoubles(doubles);
    ({ worker } = await buildDigestWorker(doubles));
  });

  it("asks for the meeting's transcribed recordings over the bus, after the answer", async () => {
    await worker.drain();

    expect(transcribed).toHaveBeenCalledTimes(1);
    expect(transcribed).toHaveBeenCalledWith(new FindTranscribedRecordingsQuery(DIGEST_MEETING_ID));
    expect(generate.mock.invocationCallOrder[0]).toBeLessThan(
      transcribed.mock.invocationCallOrder[0] ?? 0,
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('discards an answer one of whose recordings has been deleted, and hands the claim back uncounted', async () => {
    // The second of the two it read is no longer among the transcribed.
    transcribed.mockResolvedValue(TRANSCRIBED.filter(({ id }) => id === FIRST_RECORDING_ID));

    await expect(worker.drain()).resolves.toBe(1);

    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    // `release` is the write that decrements the claim count: a delete is not a failed try.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
  });

  it('discards an answer when every recording it read has been deleted', async () => {
    transcribed.mockResolvedValue([]);

    await worker.drain();

    expect(complete).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
  });

  it('stores an answer when a recording was added meanwhile: the read marks it out of date', async () => {
    transcribed.mockResolvedValue([
      ...TRANSCRIBED,
      { id: 'a-third-recording', uploaderId: TRANSCRIBED[0]?.uploaderId ?? '' },
    ]);

    await worker.drain();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('looks at the recordings of an answer once more after storing it, and not before', async () => {
    await worker.drain();

    expect(recheckStored).toHaveBeenCalledTimes(1);
    expect(recheckStored).toHaveBeenCalledWith(DIGEST_MEETING_ID, [
      FIRST_RECORDING_ID,
      SECOND_RECORDING_ID,
    ]);
    // After the write: a delete followed before it found nothing of this answer to remove.
    expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
      recheckStored.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('looks again at an answer stored under a row that was queued meanwhile', async () => {
    complete.mockResolvedValue('QUEUED');

    await worker.drain();

    expect(recheckStored).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['whose claim was lost', (): void => void complete.mockResolvedValue(null)],
    ['that could not be stored', (): void => void complete.mockRejectedValue(new Error('0x00'))],
    ['that was discarded', (): void => void transcribed.mockResolvedValue([])],
    ['that failed', (): void => void generate.mockRejectedValue(new Error('overloaded'))],
  ])('takes no second look for an answer %s: nothing of it is stored', async (_case, arrange) => {
    arrange();

    await worker.drain();

    expect(recheckStored).not.toHaveBeenCalled();
  });

  it('fails a digest whose recordings could not be checked, in the generic sentence', async () => {
    transcribed.mockRejectedValue(new Error('connection terminated'));

    await worker.drain();

    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(HELD, GENERIC);
  });

  it('checks nothing when there was nothing to generate from', async () => {
    execute.mockResolvedValue({ withinLimit: true, transcripts: [] });

    await worker.drain();

    expect(transcribed).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(HELD);
  });

  it('announces the claim before it asks Claude, and the stored digest after', async () => {
    const order: string[] = [];
    announce.mockImplementation(async () => {
      order.push('announce');
    });
    generate.mockImplementation(async () => {
      order.push('generate');

      return GENERATED;
    });
    complete.mockImplementation(async () => {
      order.push('complete');

      return 'READY';
    });

    await worker.drain();

    expect(order).toEqual(['announce', 'generate', 'complete', 'announce']);
    expect(announce).toHaveBeenCalledWith(DIGEST_MEETING_ID);
  });

  it('announces a discarded answer as the row it left: queued again', async () => {
    transcribed.mockResolvedValue([]);

    await worker.drain();

    // The claim, then the hand-back.
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('announces a claim it then lost only once: the write that was not made changed nothing', async () => {
    complete.mockResolvedValue(null);

    await worker.drain();

    expect(announce).toHaveBeenCalledTimes(1);
  });
});
