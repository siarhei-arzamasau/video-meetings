import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';

import { holdWrite } from '../../services/held-write.fixture';
import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import type { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { runTranscription } from './transcription-run';
import type { TranscriptionRun } from './transcription-run';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const KEY = `${MEETING_ID}/${FILE_ID}`;
const LEASE = new Date(Date.now() + 60_000);

const CLAIMED = buildMeetingFileRecord({
  id: FILE_ID,
  meetingId: MEETING_ID,
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  storageKey: KEY,
  checksum: 'sha',
  status: 'ready',
  attempts: 1,
  processedAt: new Date('2026-10-07T10:00:01.000Z'),
  transcriptionStatus: TranscriptionStatus.TRANSCRIBING,
  transcriptionAttempts: 1,
  transcriptionLeasedUntil: LEASE,
});

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A provider that honours its signal, as the port requires, and answers only when told to. */
const answerOnDemand =
  (answers: { resolve?: (text: string) => void }) =>
  (_stream: Readable, _type: string, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      answers.resolve = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

describe('runTranscription', () => {
  const transcribe = jest.fn();
  const renewLease = jest.fn();
  const openRead = jest.fn();
  let shutdown: AbortController;

  const run = (leaseSeconds = 30, limitSeconds = 720): Promise<TranscriptionRun> =>
    runTranscription({
      claimed: CLAIMED,
      provider: { transcribe },
      storage: { openRead } as unknown as MeetingFileStorage,
      leases: { renewLease },
      logger: new Logger('test'),
      leaseSeconds,
      limitSeconds,
      shutdown: shutdown.signal,
    });

  /** The signal the provider was handed on its one call. */
  const signalSeen = (): AbortSignal =>
    (transcribe.mock.calls[0] as [Readable, string, AbortSignal])[2];

  beforeEach(() => {
    shutdown = new AbortController();
    transcribe.mockReset().mockResolvedValue('Good morning, everyone.');
    renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
    openRead.mockReset().mockImplementation(() => new PassThrough());
  });

  it('hands the provider the object as a stream, its type, and a signal nothing has aborted', async () => {
    await expect(run()).resolves.toEqual({
      held: LEASE,
      outcome: { text: 'Good morning, everyone.' },
      timedOut: false,
      shuttingDown: false,
    });

    expect(openRead).toHaveBeenCalledWith(KEY);
    const [stream, contentType] = transcribe.mock.calls[0] as [Readable, string];
    // A stream, not a buffer: a gigabyte of video must not be read into memory to be sent.
    expect(typeof stream.pipe).toBe('function');
    expect(contentType).toBe('audio/mpeg');
    expect(signalSeen().aborted).toBe(false);
  });

  it('closes the stream it opened, whether the provider answered or threw', async () => {
    await run();
    transcribe.mockRejectedValue(new Error('refused'));
    await run();

    const streams = openRead.mock.results.map(({ value }) => value as Readable);
    expect(streams.map((stream) => stream.destroyed)).toEqual([true, true]);
  });

  it('reports a provider error as an outcome rather than throwing it', async () => {
    const refused = new Error('refused');
    transcribe.mockRejectedValue(refused);

    await expect(run()).resolves.toEqual({
      held: LEASE,
      outcome: { error: refused },
      timedOut: false,
      shuttingDown: false,
    });
  });

  it('reports an object that cannot be opened as an outcome too, and stops renewing', async () => {
    const unopenable = new Error('Not a storage key');
    openRead.mockImplementation(() => {
      throw unopenable;
    });

    await expect(run(3)).resolves.toEqual({
      held: LEASE,
      outcome: { error: unopenable },
      timedOut: false,
      shuttingDown: false,
    });
    expect(transcribe).not.toHaveBeenCalled();

    // A heartbeat left running would renew a claim nobody is working on, for ever.
    await settle(1_200);
    expect(renewLease).not.toHaveBeenCalled();
  });

  it('does not renew for a request that answers well inside the lease', async () => {
    await run();

    expect(renewLease).not.toHaveBeenCalled();
  });

  it('aborts a request that outruns the time limit, and says the limit is what ended it', async () => {
    transcribe.mockImplementation(answerOnDemand({}));

    // Seconds, as the environment states them — a fraction only because a spec cannot wait
    // out the contract's thirty second floor.
    const ended = await run(30, 0.05);

    expect(ended).toMatchObject({
      held: LEASE,
      outcome: { error: expect.any(Error) },
      timedOut: true,
    });
    expect(signalSeen().aborted).toBe(true);
  });

  it('does not blame the limit for a provider error because the heartbeat was slow to stop', async () => {
    const refused = new Error('refused');
    const provider: { fail?: (error: Error) => void } = {};
    const renewal = holdWrite<Date>();
    renewLease.mockReturnValue(renewal.answered);
    transcribe.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          provider.fail = reject;
        }),
    );

    // A renewal goes out a second in and stays out. The provider fails at 1.1s, inside the
    // 1.3s limit; the limit then passes while `stop` is still waiting for that renewal.
    const running = run(3, 1.3);
    await settle(1_100);
    provider.fail?.(refused);
    await settle(400);
    renewal.answer(new Date(Date.now() + 3_000));

    await expect(running).resolves.toMatchObject({ outcome: { error: refused }, timedOut: false });
    expect(renewLease).toHaveBeenCalledTimes(1);
  });

  it('renews the lease while the provider works, and hands back the lease the row now holds', async () => {
    const renewed = new Date(Date.now() + 3_000);
    const answers: { resolve?: (text: string) => void } = {};
    renewLease.mockResolvedValue(renewed);
    transcribe.mockImplementation(answerOnDemand(answers));

    const running = run(3);
    await settle(1_200);
    answers.resolve?.('Late, but whole.');

    await expect(running).resolves.toEqual({
      held: renewed,
      outcome: { text: 'Late, but whole.' },
      timedOut: false,
      shuttingDown: false,
    });
    expect(renewLease).toHaveBeenCalledWith(FILE_ID, LEASE, 3);
  });

  it('hangs up on the provider when a renewal finds the claim gone, and holds no lease', async () => {
    // Zero rows: the file was deleted, or the lease lapsed and another worker took the claim.
    renewLease.mockResolvedValue(null);
    transcribe.mockImplementation(answerOnDemand({}));

    const ended = await run(3);

    expect(ended).toMatchObject({ held: null, timedOut: false });
    expect(signalSeen().aborted).toBe(true);
  });

  it('hangs up when the process is shutting down, with the lease still held', async () => {
    transcribe.mockImplementation(answerOnDemand({}));

    const running = run();
    await settle(20);
    shutdown.abort();

    await expect(running).resolves.toMatchObject({
      held: LEASE,
      timedOut: false,
      shuttingDown: true,
    });
    expect(signalSeen().aborted).toBe(true);
  });

  it('does not call a provider error a shutdown because one began while the heartbeat stopped', async () => {
    const refused = new Error('refused');
    const provider: { fail?: (error: Error) => void } = {};
    const renewal = holdWrite<Date>();
    renewLease.mockReturnValue(renewal.answered);
    transcribe.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          provider.fail = reject;
        }),
    );

    // The renewal goes out a second in and stays out; the provider fails, and only then does
    // the process start to shut down, while `stop` is still waiting for that renewal.
    const running = run(3);
    await settle(1_100);
    provider.fail?.(refused);
    await settle(20);
    shutdown.abort();
    renewal.answer(new Date(Date.now() + 3_000));

    await expect(running).resolves.toMatchObject({
      outcome: { error: refused },
      shuttingDown: false,
    });
  });
});
