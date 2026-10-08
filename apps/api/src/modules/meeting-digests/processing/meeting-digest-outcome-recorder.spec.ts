import type { Logger } from '@nestjs/common';

import { ClaudeAgentFailure, ClaudeModel } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import { NO_DIGEST_STATUS } from '../services/meeting-digest-claim-writes';
import type { MeetingDigestClaimRepository } from '../services/meeting-digest-claim.repository';
import { FIRST_RECORDING_ID } from '../services/meeting-digest-record.fixture';
import { DigestStatus } from '../services/meeting-digest-status';
import { DigestOutcomeRecorder, spendOf } from './meeting-digest-outcome-recorder';
import { CLAIMED, GENERATED, HELD, LEASE } from './meeting-digest-worker.fixture';

const { QUEUED, READY, FAILED } = DigestStatus;
const REASON = 'The digest could not be generated.';
const MODEL = ClaudeModel.SONNET;

/**
 * What each ending writes, and what it leaves in the log — which for a digest is not a
 * nicety: the log is the only place a generation's cost is kept.
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
    it('stores the answer and its sources under the lease held and the request claimed', async () => {
      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      expect(complete).toHaveBeenCalledWith(HELD, {
        answer: GENERATED.answer,
        sourceFileIds: [FIRST_RECORDING_ID],
      });
    });

    it('logs the generation with its duration, the model that answered, and what it cost', async () => {
      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      const lines = logged();
      expect(lines).toContain(`Digest of meeting ${CLAIMED.meetingId}`);
      expect(lines).toContain('claude-sonnet-5-5');
      expect(lines).toContain('$0.0041');
      expect(lines).toMatch(/in 3\d{3}ms/);
      expect(lines).toContain('GENERATING -> READY');
    });

    it('passes nothing of the cost, the model, or the tokens to what is stored', async () => {
      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      const stored = JSON.stringify(complete.mock.calls);
      for (const unstored of ['costUsd', '0.0041', 'claude-sonnet', 'inputTokens', '3037']) {
        expect(stored).not.toContain(unstored);
      }
    });

    it('records a digest that cannot be stored as failed, rather than leave it to be paid for again', async () => {
      // Text the database will not hold, say. The transaction rolled back, so the claim stands.
      complete.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'));

      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      expect(fail).toHaveBeenCalledWith(HELD, REASON);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('could not be stored'),
        expect.stringContaining('invalid byte sequence'),
      );
      expect(logged()).toContain('GENERATING -> FAILED');
    });

    it('says the digest was queued again when another request was made meanwhile', async () => {
      complete.mockResolvedValue(QUEUED);

      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      expect(logged()).toContain('GENERATING -> QUEUED');
    });

    it('still logs the cost of a digest whose claim was lost, and says it was discarded', async () => {
      complete.mockResolvedValue(null);

      await recorder.complete(CLAIMED, LEASE, GENERATED, [FIRST_RECORDING_ID], startedAt);

      expect(logged()).toContain('$0.0041');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('result discarded'));
    });
  });

  describe('fail', () => {
    it('stores the reason it was given and nothing else', async () => {
      await recorder.fail(
        CLAIMED,
        LEASE,
        { reason: REASON, model: MODEL, costUsd: 0.02 },
        startedAt,
      );

      expect(fail).toHaveBeenCalledWith(HELD, REASON);
    });

    it('logs what a failed generation cost, and the model that was asked', async () => {
      await recorder.fail(
        CLAIMED,
        LEASE,
        { reason: REASON, model: MODEL, costUsd: 0.02 },
        startedAt,
      );

      expect(error).toHaveBeenCalledWith(expect.stringContaining('$0.0200'));
      expect(logged()).toContain(MODEL);
      expect(logged()).toContain('GENERATING -> FAILED');
    });

    it('says so when a failed generation reported no cost', async () => {
      await recorder.fail(CLAIMED, LEASE, { reason: REASON, model: MODEL }, startedAt);

      expect(error).toHaveBeenCalledWith(expect.stringContaining('no cost reported'));
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
    await recorder.release(CLAIMED, LEASE, null, startedAt);

    expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
    expect(logged()).toContain('GENERATING -> QUEUED');
    expect(logged()).not.toContain('$');

    release.mockResolvedValue(false);
    await recorder.release(CLAIMED, LEASE, null, startedAt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not released'));
  });

  it('logs what a call cost when shutdown hung up on one that had already been paid for', async () => {
    await recorder.release(CLAIMED, LEASE, { model: MODEL, costUsd: 0.02 }, startedAt);

    expect(logged()).toContain('$0.0200');
    expect(release).toHaveBeenCalledWith(CLAIMED.id, LEASE);
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

  describe('a claim lost before there was anything to write', () => {
    it('writes nothing, and still logs what the discarded call cost', () => {
      recorder.abandoned(CLAIMED, spendOf({ generated: GENERATED, sourceFileIds: [] }), startedAt);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-sonnet-5-5'));
      expect(logged()).toContain('$0.0041');
      expect(logged()).toContain('result discarded');
      for (const write of [complete, fail, release, clear]) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it('logs the cost of a call that failed, when it reported one', () => {
      const answeredTooLate = new ClaudeAgentError(ClaudeAgentFailure.FAILED, 'late', {
        costUsd: 0.02,
      });

      recorder.abandoned(CLAIMED, spendOf({ error: answeredTooLate }), startedAt);

      expect(logged()).toContain('$0.0200');
    });

    it('logs no cost for a run that made no call, or whose call reported none', () => {
      expect(spendOf({ nothingToGenerate: true })).toBeNull();
      expect(spendOf({ error: new Error('ENOENT') })).toBeNull();

      recorder.abandoned(CLAIMED, null, startedAt);

      expect(logged()).not.toContain('$');
      expect(logged()).toContain('result discarded');
    });
  });

  it('logs a claim with the status it was taken from and how many times it has been taken', () => {
    recorder.claimed(CLAIMED);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('QUEUED -> GENERATING, claim 1'));
  });
});
