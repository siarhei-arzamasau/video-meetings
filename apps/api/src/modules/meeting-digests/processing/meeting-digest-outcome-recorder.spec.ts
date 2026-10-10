import type { Logger } from '@nestjs/common';

import { ClaudeModel } from '../../claude-agent/claude-agent.constants';
import { NO_DIGEST_STATUS } from '../services/meeting-digest-claim-writes';
import type { MeetingDigestClaimRepository } from '../services/meeting-digest-claim.repository';
import { DigestStatus } from '../services/meeting-digest-status';
import { DigestOutcomeRecorder } from './meeting-digest-outcome-recorder';
import { CLAIMED, GENERATED, HELD, LEASE, STORABLE } from './meeting-digest-worker.fixture';

const { QUEUED, READY, FAILED } = DigestStatus;
const REASON = 'The digest could not be generated.';
const MODEL = ClaudeModel.SONNET;

/**
 * What each ending writes, and what it leaves in the log: how the generation ended, and
 * never what it cost — `MeetingDigestGenerator` logged that when the run's result arrived.
 */
describe('DigestOutcomeRecorder', () => {
  const complete = jest.fn();
  const fail = jest.fn();
  const release = jest.fn();
  const clear = jest.fn();
  const log = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  const recorder = new DigestOutcomeRecorder(
    { complete, fail, release, clear } as unknown as MeetingDigestClaimRepository,
    { log, warn, error } as unknown as Logger,
    async () => undefined,
  );
  const startedAt = Date.now() - 3_200;

  /** Every line logged at any level, as one text. */
  const logged = (): string =>
    [log, warn, error]
      .flatMap((level) => level.mock.calls.map(([line]: [string]) => line))
      .join('\n');

  beforeEach(() => {
    complete.mockReset().mockResolvedValue(READY);
    fail.mockReset().mockResolvedValue(FAILED);
    release.mockReset().mockResolvedValue(true);
    clear.mockReset().mockResolvedValue(NO_DIGEST_STATUS);
    for (const level of [log, warn, error]) {
      level.mockReset();
    }
  });

  describe('complete', () => {
    it('stores the answer, its sources, and its owners\u2019 links under the lease held and the request claimed', async () => {
      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      const { generated, sourceFileIds, ownerLinks } = STORABLE;

      expect(ownerLinks.size).toBe(1);
      expect(complete).toHaveBeenCalledWith(HELD, {
        answer: generated.answer,
        sourceFileIds,
        ownerLinks,
      });
    });

    it('logs the generation with its duration and the model that answered', async () => {
      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      const lines = logged();
      expect(lines).toContain(`Digest of meeting ${CLAIMED.meetingId}`);
      expect(lines).toContain('claude-sonnet-5-5');
      expect(lines).toMatch(/in 3\d{3}ms/);
      expect(lines).toContain('GENERATING -> READY');
    });

    it('passes nothing of the cost, the model, or the tokens to what is stored', async () => {
      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      const stored = JSON.stringify(complete.mock.calls);
      for (const unstored of ['costUsd', '0.0041', 'claude-sonnet', 'inputTokens', '3037']) {
        expect(stored).not.toContain(unstored);
      }
    });

    it('records a digest that cannot be stored as failed, rather than leave it to be paid for again', async () => {
      // Text the database will not hold, say. The transaction rolled back, so the claim stands.
      complete.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'));

      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      expect(fail).toHaveBeenCalledWith(HELD, REASON);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('could not be stored'),
        expect.stringContaining('invalid byte sequence'),
      );
      expect(logged()).toContain('GENERATING -> FAILED');
    });

    it('says the digest was queued again when another request was made meanwhile', async () => {
      complete.mockResolvedValue(QUEUED);

      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      expect(logged()).toContain('GENERATING -> QUEUED');
    });

    it('says a digest whose claim was lost was discarded', async () => {
      complete.mockResolvedValue(null);

      await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('result discarded'));
    });
  });

  describe('fail', () => {
    it('stores the reason it was given and nothing else', async () => {
      await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);

      expect(fail).toHaveBeenCalledWith(HELD, REASON);
    });

    it('logs a failed generation with the model that was asked and the reason it shows', async () => {
      await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);

      expect(error).toHaveBeenCalledWith(expect.stringContaining(`${MODEL} after`));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`(${REASON})`));
      expect(logged()).toContain('GENERATING -> FAILED');
    });

    it('says the failure was dropped for a new request, or lost with the claim', async () => {
      fail.mockResolvedValueOnce(QUEUED).mockResolvedValueOnce(null);

      await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);
      expect(logged()).toContain('GENERATING -> QUEUED');

      await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not recorded as failed'));
    });
  });

  it('releases the claim under the lease held, and says when the claim was already gone', async () => {
    await recorder.release(CLAIMED, LEASE, startedAt);

    expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
    expect(logged()).toContain('GENERATING -> QUEUED');

    release.mockResolvedValue(false);
    await recorder.release(CLAIMED, LEASE, startedAt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not released'));
  });

  it('clears the status under the lease held and the request claimed, and says when the claim was already gone', async () => {
    await recorder.clear(CLAIMED, LEASE, startedAt);

    expect(clear).toHaveBeenCalledWith(HELD);
    expect(logged()).toContain('GENERATING -> none');

    clear.mockResolvedValue(null);
    await recorder.clear(CLAIMED, LEASE, startedAt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not cleared'));
  });

  it('says the digest was queued instead when a request was made while the claim found nothing', async () => {
    clear.mockResolvedValue(QUEUED);

    await recorder.clear(CLAIMED, LEASE, startedAt);

    expect(logged()).toContain('GENERATING -> QUEUED');
    expect(logged()).not.toContain('-> none');
  });

  it('writes nothing for a claim lost before there was anything to write, and says the result was discarded', () => {
    recorder.abandoned(CLAIMED);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('result discarded'));
    for (const write of [complete, fail, release, clear]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('logs a cost at no ending: a run is logged with what it cost once, where its result arrives', async () => {
    await recorder.claimed(CLAIMED);
    await recorder.complete(CLAIMED, LEASE, STORABLE, startedAt);
    await recorder.discard(CLAIMED, LEASE, GENERATED, startedAt);
    await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);
    await recorder.release(CLAIMED, LEASE, startedAt);
    await recorder.clear(CLAIMED, LEASE, startedAt);
    recorder.abandoned(CLAIMED);

    // `GENERATED` cost $0.0041, for 3,037 tokens in and 300 out.
    expect(logged()).not.toMatch(/\$|0\.0041|3037|tokens/);
  });

  it('logs a claim with the status it was taken from and how many times it has been taken', async () => {
    await recorder.claimed(CLAIMED);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('QUEUED -> GENERATING, claim 1'));
  });
});
