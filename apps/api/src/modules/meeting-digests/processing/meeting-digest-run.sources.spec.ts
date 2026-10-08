import type { Logger } from '@nestjs/common';

import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
import { FIRST_RECORDING_ID, SECOND_RECORDING_ID } from '../services/meeting-digest-record.fixture';
import { runDigestGeneration } from './meeting-digest-run';
import { CLAIMED, GENERATED, LEASE, TRANSCRIPTS } from './meeting-digest-worker.fixture';

/**
 * The check a generation ends with: an answer is reported for storing only if every
 * recording it was built from is still transcribed once it has arrived.
 */
describe('runDigestGeneration: the recordings an answer was built from', () => {
  const renewLease = jest.fn();
  const readTranscripts = jest.fn();
  const readTranscribedIds = jest.fn();
  const generate = jest.fn();
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

  const run = ({ limitSeconds = 60 } = {}): ReturnType<typeof runDigestGeneration> =>
    runDigestGeneration({
      claimed: CLAIMED,
      readTranscripts,
      readTranscribedIds,
      generate,
      leases: { renewLease },
      logger,
      leaseSeconds: 30,
      limitSeconds,
      shutdown: new AbortController().signal,
    });

  beforeEach(() => {
    renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
    readTranscripts.mockReset().mockResolvedValue(TRANSCRIPTS);
    readTranscribedIds.mockReset().mockResolvedValue([FIRST_RECORDING_ID, SECOND_RECORDING_ID]);
    generate.mockReset().mockResolvedValue(GENERATED);
  });

  it('asks which recordings are still transcribed only once it has an answer to check', async () => {
    const order: string[] = [];
    generate.mockImplementation(async () => {
      order.push('generated');

      return GENERATED;
    });
    readTranscribedIds.mockImplementation(async () => {
      order.push('checked');

      return [FIRST_RECORDING_ID, SECOND_RECORDING_ID];
    });

    await run();

    expect(order).toEqual(['generated', 'checked']);
    expect(readTranscribedIds).toHaveBeenCalledWith(CLAIMED.meetingId);

    // Nothing to send is nothing to check.
    readTranscribedIds.mockClear();
    readTranscripts.mockResolvedValue({ withinLimit: true, transcripts: [] });
    await run();
    expect(readTranscribedIds).not.toHaveBeenCalled();
  });

  it('does not name the time limit for an answer that arrived inside it, however long the check takes', async () => {
    readTranscribedIds.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));

      return [FIRST_RECORDING_ID, SECOND_RECORDING_ID];
    });

    // The check alone outlasts the limit; the generation before it was instant.
    await expect(run({ limitSeconds: 0.05 })).resolves.toMatchObject({
      outcome: { generated: GENERATED },
      interruptedBy: null,
    });
  });

  it('reports an answer one of whose recordings was deleted meanwhile as not to be stored', async () => {
    readTranscribedIds.mockResolvedValue([FIRST_RECORDING_ID]);

    await expect(run()).resolves.toEqual({
      held: LEASE,
      // The answer is still handed over, for what it cost; its sources are not.
      outcome: { generated: GENERATED, sourceDeleted: true },
      interruptedBy: null,
    });
  });

  it('reports an answer for storing when a recording was added meanwhile: it is whole, only out of date', async () => {
    readTranscribedIds.mockResolvedValue([FIRST_RECORDING_ID, SECOND_RECORDING_ID, 'a-third']);

    await expect(run()).resolves.toMatchObject({
      outcome: { generated: GENERATED, sourceFileIds: [FIRST_RECORDING_ID, SECOND_RECORDING_ID] },
    });
  });

  it('fails a generation whose recordings could not be checked, and keeps what the answer cost', async () => {
    const failure = new Error('connection terminated');
    readTranscribedIds.mockRejectedValue(failure);

    const { held, outcome } = await run();

    expect(held).toEqual(LEASE);
    expect(outcome).toEqual({ error: expect.any(MeetingDigestError) });
    const { error } = outcome as { error: MeetingDigestError };
    expect(error.failure).toBe(MeetingDigestFailure.SOURCES_UNCHECKED);
    expect(error.costUsd).toBe(GENERATED.costUsd);
    expect(error.cause).toBe(failure);
  });
});
