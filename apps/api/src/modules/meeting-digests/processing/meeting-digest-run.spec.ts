import type { Logger } from '@nestjs/common';

import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { FIRST_RECORDING_ID, SECOND_RECORDING_ID } from '../services/meeting-digest-record.fixture';
import { DigestInterruption, runDigestGeneration } from './meeting-digest-run';
import type { DigestRunOptions } from './meeting-digest-run';
import {
  CLAIMED,
  GENERATED,
  LEASE,
  TRANSCRIPTS,
  untilHungUp,
} from './meeting-digest-worker.fixture';

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One generation under a lease: what it reports, and — the part with a trap in it — which
 * of the three things that can hang up on Claude is named as the one that did.
 */
describe('runDigestGeneration', () => {
  const renewLease = jest.fn();
  const readTranscripts = jest.fn();
  const readTranscribedIds = jest.fn();
  const generate = jest.fn();
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
  let shutdown: AbortController;

  const run = (overrides: Partial<DigestRunOptions> = {}): ReturnType<typeof runDigestGeneration> =>
    runDigestGeneration({
      claimed: CLAIMED,
      readTranscripts,
      readTranscribedIds,
      generate,
      leases: { renewLease },
      logger,
      leaseSeconds: 30,
      limitSeconds: 60,
      shutdown: shutdown.signal,
      ...overrides,
    });

  beforeEach(() => {
    shutdown = new AbortController();
    renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
    readTranscripts.mockReset().mockResolvedValue(TRANSCRIPTS);
    readTranscribedIds.mockReset().mockResolvedValue([FIRST_RECORDING_ID, SECOND_RECORDING_ID]);
    generate.mockReset().mockResolvedValue(GENERATED);
  });

  it('reports the digest with the recordings it was built from, under the lease still held', async () => {
    await expect(run()).resolves.toEqual({
      held: LEASE,
      outcome: { generated: GENERATED, sourceFileIds: [FIRST_RECORDING_ID, SECOND_RECORDING_ID] },
      interruptedBy: null,
    });
    expect(readTranscripts).toHaveBeenCalledWith(CLAIMED.meetingId);
  });

  it('reports that there is nothing to generate from, and sends nothing', async () => {
    readTranscripts.mockResolvedValue({ withinLimit: true, transcripts: [] });

    await expect(run()).resolves.toMatchObject({
      outcome: { nothingToGenerate: true },
      interruptedBy: null,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('reports transcripts past the cap as too long, and sends nothing', async () => {
    readTranscripts.mockResolvedValue({ withinLimit: false });

    const { outcome } = await run();

    expect(generate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ error: expect.any(MeetingDigestError) });
    expect((outcome as { error: MeetingDigestError }).error.failure).toBe(
      MeetingDigestFailure.TRANSCRIPTS_TOO_LONG,
    );
  });

  it('reports an ordinary error as interrupted by nothing', async () => {
    const failure = new Error('overloaded');
    generate.mockRejectedValue(failure);

    await expect(run()).resolves.toEqual({
      held: LEASE,
      outcome: { error: failure },
      interruptedBy: null,
    });
  });

  it('names the time limit when the limit is what hung up', async () => {
    generate.mockImplementation(untilHungUp);

    await expect(run({ limitSeconds: 0.05 })).resolves.toMatchObject({
      held: LEASE,
      interruptedBy: DigestInterruption.TIME_LIMIT,
    });
  });

  it('names shutdown when shutdown is what hung up', async () => {
    generate.mockImplementation(untilHungUp);
    const running = run();
    await settle(20);

    shutdown.abort();

    await expect(running).resolves.toMatchObject({ interruptedBy: DigestInterruption.SHUTDOWN });
  });

  it('still names the time limit when shutdown begins before the hung-up call has rejected', async () => {
    // The SDK's rejection trails an abort by up to two seconds. A deploy that lands in that
    // gap did not end the generation, and must not have it handed back to time out again.
    generate.mockImplementation(async (transcripts: ReadonlyArray<string>, signal: AbortSignal) => {
      try {
        return await untilHungUp(transcripts, signal);
      } catch (error) {
        shutdown.abort();
        await settle(10);

        throw error;
      }
    });

    await expect(run({ limitSeconds: 0.05 })).resolves.toMatchObject({
      interruptedBy: DigestInterruption.TIME_LIMIT,
    });
  });

  it('does not blame a shutdown that began after the generation had already failed', async () => {
    const failure = new Error('overloaded');
    // The first renewal starts a second in, is still in flight when the generation fails a
    // tenth of a second later, and shutdown begins before it returns: stopping the heartbeat
    // waits for it, and a shutdown that fires during that wait ended nothing.
    renewLease.mockImplementation(async () => {
      await settle(200);
      shutdown.abort();
      await settle(100);

      return LEASE;
    });
    generate.mockImplementation(async () => {
      await settle(1_100);

      throw failure;
    });

    const { outcome, interruptedBy } = await run({ leaseSeconds: 3 });

    expect(shutdown.signal.aborted).toBe(true);
    expect(outcome).toEqual({ error: failure });
    expect(interruptedBy).toBeNull();
  });

  it('hangs up, and holds nothing, once a renewal finds the claim gone', async () => {
    renewLease.mockResolvedValue(null);
    generate.mockImplementation(untilHungUp);

    await expect(run({ leaseSeconds: 3 })).resolves.toMatchObject({
      held: null,
      interruptedBy: DigestInterruption.CLAIM_LOST,
    });
  });

  it('starts the time limit with the request, not with the read before it', async () => {
    readTranscripts.mockImplementation(async () => {
      await settle(120);

      return TRANSCRIPTS;
    });

    // The read alone outlasts the limit; the generation that follows it is instant.
    await expect(run({ limitSeconds: 0.05 })).resolves.toMatchObject({
      outcome: { generated: GENERATED },
      interruptedBy: null,
    });
  });

  it('stops the heartbeat when the transcripts cannot be read, and reports the error', async () => {
    const failure = new Error('ENOENT');
    readTranscripts.mockRejectedValue(failure);

    await expect(run({ leaseSeconds: 3 })).resolves.toEqual({
      held: LEASE,
      outcome: { error: failure },
      interruptedBy: null,
    });
    await settle(1_100);

    expect(renewLease).not.toHaveBeenCalled();
  });
});
