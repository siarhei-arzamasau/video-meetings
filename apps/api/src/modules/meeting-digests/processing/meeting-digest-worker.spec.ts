import { Logger } from '@nestjs/common';

import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import { FindMeetingTranscriptsQuery } from '../../meeting-files/queries/find-meeting-transcripts.query';
import { MAX_DIGEST_TRANSCRIPT_CHARACTERS } from '../meeting-digest.constants';
import { MeetingDigestError, MeetingDigestFailure } from '../meeting-digest.error';
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
  OWNER_LINKS,
  SDK_WORDS,
  buildDigestWorker,
  digestWorkerDoubles,
  resetDigestWorkerDoubles,
  untilHungUp,
} from './meeting-digest-worker.fixture';

const GENERIC = 'The digest could not be generated.';
const TOO_LONG = 'The recordings of this meeting are too long to turn into one digest.';
const REPEATED = 'The digest could not be generated after repeated attempts.';

/**
 * What the worker decides: which claim is run, and what each way a run can end is recorded
 * as. How a generation is hung up on is `meeting-digest-run.spec.ts`'s, the sentence a
 * failure shows `meeting-digest-failure.spec.ts`'s, and what is logged the recorder's.
 */
describe('MeetingDigestWorker: one claim, start to finish', () => {
  const doubles = digestWorkerDoubles();
  const { claimNext, renewLease, complete, fail, release, clear, execute, generate } = doubles;
  let worker: MeetingDigestWorker;

  /** The reason a failure was recorded with, as `fail` was given it. */
  const failedWith = (): unknown => fail.mock.calls[0]?.[1];

  beforeAll(() => {
    // The worker logs every edge and every failure; a spec run is not where to read them.
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    resetDigestWorkerDoubles(doubles);
    ({ worker } = await buildDigestWorker(doubles));
  });

  it('is reachable under its string token, claims under the configured lease, and counts what it handled', async () => {
    expect(worker).toBeInstanceOf(MeetingDigestWorker);
    await expect(worker.drain()).resolves.toBe(1);

    expect(claimNext).toHaveBeenCalledWith(30);
  });

  it("asks for the meeting's transcripts over the bus, bounded by the cap", async () => {
    await worker.drain();

    expect(execute).toHaveBeenCalledWith(
      new FindMeetingTranscriptsQuery(DIGEST_MEETING_ID, MAX_DIGEST_TRANSCRIPT_CHARACTERS),
    );
  });

  it('takes a claim to a stored digest: the transcripts in upload order, the answer, its sources', async () => {
    await worker.drain();

    expect(generate).toHaveBeenCalledWith(
      ['We ship on Friday.', 'Grace sends the release notes.'],
      expect.any(AbortSignal),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(HELD, {
      answer: GENERATED.answer,
      sourceFileIds: [FIRST_RECORDING_ID, SECOND_RECORDING_ID],
      ownerLinks: OWNER_LINKS,
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it('writes under the lease the last renewal set, not the one the claim was given', async () => {
    const renewed = new Date(Date.now() + 90_000);
    renewLease.mockResolvedValue(renewed);
    const { worker: shortLease } = await buildDigestWorker(doubles, {
      MEETING_FILES_LEASE_SECONDS: 3,
    });
    generate.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(GENERATED), 1_200)),
    );

    await shortLease.drain();

    expect(complete).toHaveBeenCalledWith({ ...HELD, lease: renewed }, expect.anything());
  });

  describe('when the generation fails', () => {
    beforeEach(() => {
      generate.mockRejectedValue(new ClaudeAgentError(ClaudeAgentFailure.FAILED, SDK_WORDS));
    });

    it('fails the digest with the generic sentence and stores no content', async () => {
      await worker.drain();

      expect(fail).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledWith(HELD, GENERIC);
      expect(complete).not.toHaveBeenCalled();
      // The first error ends it: there is no second paid request behind the user's back.
      expect(generate).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    });

    it('keeps the SDK’s own words out of everything it writes', async () => {
      await worker.drain();

      expect(JSON.stringify(fail.mock.calls)).not.toContain('req_7f3a');
    });
  });

  it.each([
    [
      'a token Anthropic refuses',
      new ClaudeAgentError(ClaudeAgentFailure.AUTHENTICATION, SDK_WORDS),
      GENERIC,
    ],
    [
      'an answer that is not a digest',
      new MeetingDigestError(MeetingDigestFailure.INVALID_ANSWER, SDK_WORDS, { costUsd: 0.004 }),
      GENERIC,
    ],
    [
      'transcripts the model refuses as too long',
      new MeetingDigestError(MeetingDigestFailure.TRANSCRIPTS_TOO_LONG, SDK_WORDS),
      TOO_LONG,
    ],
  ])('fails the digest for %s', async (_case, error, reason) => {
    generate.mockRejectedValue(error);

    await worker.drain();

    expect(failedWith()).toBe(reason);
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails as too long, with nothing sent, when the transcripts are past the cap', async () => {
    execute.mockResolvedValue({ withinLimit: false });

    await worker.drain();

    expect(generate).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(HELD, TOO_LONG);
  });

  it('fails a generation that outruns the time limit with a reason naming the limit', async () => {
    const { worker: limited } = await buildDigestWorker(doubles, {
      MEETING_DIGEST_TIMEOUT_SECONDS: 1,
    });
    generate.mockImplementation(untilHungUp);

    await limited.drain();

    expect(fail).toHaveBeenCalledWith(
      HELD,
      'Generating the digest took longer than the 1-second limit.',
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('fails the digest, generically, when the transcripts cannot be read', async () => {
    execute.mockRejectedValue(new Error('ENOENT: no such file'));

    await worker.drain();

    expect(generate).not.toHaveBeenCalled();
    expect(failedWith()).toBe(GENERIC);
  });

  it('clears the status, with nothing sent, when no transcribed recording is left', async () => {
    execute.mockResolvedValue({ withinLimit: true, transcripts: [] });

    await worker.drain();

    expect(generate).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith(HELD);
    expect(fail).not.toHaveBeenCalled();
  });

  it('writes nothing once a renewal finds the claim gone, and hangs up on the generation', async () => {
    // Zero rows: the lease lapsed and another worker took the claim.
    renewLease.mockResolvedValue(null);
    const { worker: shortLease } = await buildDigestWorker(doubles, {
      MEETING_FILES_LEASE_SECONDS: 3,
    });
    generate.mockImplementation(untilHungUp);

    await expect(shortLease.drain()).resolves.toBe(1);

    for (const write of [complete, fail, release, clear]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('fails a digest claimed a fourth time without reading a transcript or sending anything', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({ ...CLAIMED, attempts: 4 })
      .mockResolvedValue(null);

    await worker.drain();

    expect(execute).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(HELD, REPEATED);
  });

  it('still runs a third claim: the cap is three, not two', async () => {
    claimNext
      .mockReset()
      .mockResolvedValueOnce({ ...CLAIMED, attempts: 3 })
      .mockResolvedValue(null);

    await worker.drain();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
