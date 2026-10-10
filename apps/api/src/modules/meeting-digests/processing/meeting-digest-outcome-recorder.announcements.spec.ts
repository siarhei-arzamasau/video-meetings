import type { Logger } from '@nestjs/common';

import { ClaudeModel } from '../../claude-agent/claude-agent.constants';
import { NO_DIGEST_STATUS } from '../services/meeting-digest-claim-writes';
import type { MeetingDigestClaimRepository } from '../services/meeting-digest-claim.repository';
import { DigestStatus } from '../services/meeting-digest-status';
import { DigestOutcomeRecorder } from './meeting-digest-outcome-recorder';
import { CLAIMED, GENERATED, LEASE, STORABLE } from './meeting-digest-worker.fixture';

const { QUEUED, READY, FAILED } = DigestStatus;
const FAILURE = { reason: 'The digest could not be generated.', model: ClaudeModel.SONNET };

/**
 * What the recorder tells open pages, and when: once after every write that landed, never
 * before it, and never for a write that lost its claim. And the one ending that exists only
 * because recordings can be deleted — an answer that is discarded.
 */
describe('DigestOutcomeRecorder: announcements, and a discarded answer', () => {
  const complete = jest.fn();
  const fail = jest.fn();
  const release = jest.fn();
  const clear = jest.fn();
  const announce = jest.fn();
  const log = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  /** Writes and announcements, in the order they were made. */
  let order: string[];
  const recorder = new DigestOutcomeRecorder(
    { complete, fail, release, clear } as unknown as MeetingDigestClaimRepository,
    { log, warn, error } as unknown as Logger,
    announce,
  );
  const startedAt = Date.now() - 3_200;

  const writes = (write: jest.Mock, name: string, answer: unknown): void => {
    write.mockReset().mockImplementation(async () => {
      order.push(name);

      return answer;
    });
  };

  /** Each way a claim ends: the write it makes, by the name `order` records it under. */
  const endings: Array<
    [string, 'complete' | 'fail' | 'release' | 'clear', () => Promise<unknown>]
  > = [
    ['an answer stored', 'complete', () => recorder.complete(CLAIMED, LEASE, STORABLE, startedAt)],
    ['a failure recorded', 'fail', () => recorder.fail(CLAIMED, LEASE, FAILURE, startedAt)],
    ['a claim released', 'release', () => recorder.release(CLAIMED, LEASE, startedAt)],
    ['a status cleared', 'clear', () => recorder.clear(CLAIMED, LEASE, startedAt)],
    [
      'an answer discarded',
      'release',
      () => recorder.discard(CLAIMED, LEASE, GENERATED, startedAt),
    ],
  ];
  const mocks = { complete, fail, release, clear };

  beforeEach(() => {
    order = [];
    writes(complete, 'complete', READY);
    writes(fail, 'fail', FAILED);
    writes(release, 'release', true);
    writes(clear, 'clear', NO_DIGEST_STATUS);
    announce.mockReset().mockImplementation(async () => {
      order.push('announce');
    });
    for (const level of [log, warn, error]) {
      level.mockReset();
    }
  });

  it('announces a claim, which `claimNext` had already committed', async () => {
    await recorder.claimed(CLAIMED);

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(CLAIMED.meetingId);
  });

  it('has announced a claim by the time it returns, so "generating" is sent before the answer is asked for', async () => {
    let announced = false;
    announce.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      announced = true;
    });

    await recorder.claimed(CLAIMED);

    expect(announced).toBe(true);
  });

  it.each(endings)('announces %s once, after the write', async (_ending, write, end) => {
    await end();

    expect(order).toEqual([write, 'announce']);
    expect(announce).toHaveBeenCalledWith(CLAIMED.meetingId);
  });

  it.each(endings)(
    'announces nothing for %s under a claim that was lost',
    async (_ending, write, end) => {
      // `release` answers whether a row changed; the others what they wrote, or null.
      mocks[write].mockResolvedValue(write === 'release' ? false : null);

      await end();

      expect(announce).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('result discarded'));
    },
  );

  it('announces a row that went back to the queue, whichever ending found the request moved', async () => {
    complete.mockResolvedValue(QUEUED);
    clear.mockResolvedValue(QUEUED);

    await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);
    await recorder.clear(CLAIMED, LEASE, startedAt);

    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('announces once for an answer that could not be stored: the failure recorded in its place', async () => {
    complete.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'));

    await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

    expect(order).toEqual(['fail', 'announce']);
  });

  it.each([
    ['stored as the digest', READY, true],
    ['stored under a row queued again', QUEUED, true],
    ['not stored, its claim lost', null, false],
  ])('answers whether the answer is stored: %s', async (_case, settledAs, stored) => {
    complete.mockResolvedValue(settledAs);

    await expect(recorder.complete(CLAIMED, LEASE, STORABLE, startedAt)).resolves.toBe(stored);
  });

  it('answers that nothing is stored when the answer could not be, and a failure was recorded', async () => {
    complete.mockRejectedValue(new Error('invalid byte sequence'));

    await expect(recorder.complete(CLAIMED, LEASE, STORABLE, startedAt)).resolves.toBe(false);
  });

  it('announces nothing for a claim abandoned before there was anything to write', () => {
    recorder.abandoned(CLAIMED);

    expect(announce).not.toHaveBeenCalled();
  });

  describe('discard', () => {
    it('stores nothing and hands the claim back as a shutdown does: queued, and uncounted', async () => {
      await recorder.discard(CLAIMED, LEASE, GENERATED, startedAt);

      expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
      for (const write of [complete, fail, clear]) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining('GENERATING -> QUEUED'));
    });

    it('logs the model that wrote the discarded answer, and why it was not kept', async () => {
      await recorder.discard(CLAIMED, LEASE, GENERATED, startedAt);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-sonnet-5-5'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('was deleted'));
    });
  });
});
