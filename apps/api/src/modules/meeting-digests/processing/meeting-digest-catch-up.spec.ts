import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindTranscribedRecordingsByMeetingQuery } from '../../meeting-files/queries/find-transcribed-recordings-by-meeting.query';
import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { DigestStanding } from '../services/meeting-digest-action';
import { MeetingDigestAnnouncer } from '../services/meeting-digest-announcer';
import { DigestStatus } from '../services/meeting-digest-status';
import { MeetingDigestRepository } from '../services/meeting-digest.repository';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import { MeetingDigestCatchUp } from './meeting-digest-catch-up';

const LAUNCH = 'meeting-launch';
const PRICING = 'meeting-pricing';
const HIRING = 'meeting-hiring';
const { QUEUED, GENERATING, READY, FAILED } = DigestStatus;

/** A digest row with `status`, and content built from `sourceFileIds` — none: nothing stored. */
const standing = (status: DigestStatus | null, sourceFileIds: string[] = []): DigestStanding => ({
  status,
  summary: sourceFileIds.length === 0 ? null : '',
  sources: sourceFileIds.map((meetingFileId) => ({ meetingFileId })),
});

/**
 * The catch-up against stubs: which meetings it asks about, with which recordings, and what
 * it does when something fails or the process is stopping. What a request does to a real
 * row, and that a boot really runs it, are the `meeting-digest-catch-up*` e2e specs'.
 */
describe('MeetingDigestCatchUp', () => {
  const findStandings = jest.fn();
  const requestCatchUp = jest.fn();
  const announce = jest.fn();
  const execute = jest.fn();
  const logged = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  let settings: Record<string, boolean>;
  /** Every meeting's recordings as the first look reads them, by meeting. */
  let recordings: Record<string, string[]>;
  /** A meeting's recordings as they are by its own turn, where that differs. */
  let recordingsNow: Record<string, string[]>;
  let pending: PendingDigestRequests;
  let catchUp: MeetingDigestCatchUp;

  /** The meetings the second look was taken for, in order. */
  const askedAbout = (): string[] => requestCatchUp.mock.calls.map(([meetingId]) => meetingId);

  beforeEach(async () => {
    settings = { MEETING_FILES_WORKER_ENABLED: true, MEETING_DIGEST_ENABLED: true };
    recordings = { [LAUNCH]: ['launch-1'] };
    recordingsNow = {};
    findStandings.mockReset().mockResolvedValue(new Map());
    requestCatchUp.mockReset().mockResolvedValue(true);
    announce.mockReset().mockResolvedValue(undefined);
    execute.mockReset().mockImplementation(async (query: unknown) => {
      if (query instanceof FindTranscribedRecordingsByMeetingQuery) {
        return Object.entries(recordings).map(([meetingId, fileIds]) => ({ meetingId, fileIds }));
      }

      const { meetingId } = query as FindTranscribedRecordingsQuery;
      const fileIds = recordingsNow[meetingId] ?? recordings[meetingId] ?? [];

      return fileIds.map((id) => ({ id, uploaderId: 'uploader' }));
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingDigestCatchUp,
        PendingDigestRequests,
        { provide: MeetingDigestRepository, useValue: { findStandings, requestCatchUp } },
        { provide: MeetingDigestAnnouncer, useValue: { announce } },
        { provide: QueryBus, useValue: { execute } },
        {
          provide: ConfigService,
          useValue: { get: (key: string, fallback: unknown) => settings[key] ?? fallback },
        },
      ],
    }).compile();

    catchUp = moduleRef.get(MeetingDigestCatchUp);
    pending = moduleRef.get(PendingDigestRequests);
    // After the module is compiled: Nest says through the same logger that it was.
    logged.mockClear();
    failed.mockClear();
  });

  describe('at boot', () => {
    it('catches up without holding the boot, as work shutdown and drain wait for', async () => {
      catchUp.onApplicationBootstrap();

      // Started, and not finished: the hook returned before anything was read.
      expect(requestCatchUp).not.toHaveBeenCalled();
      await pending.settled();

      expect(askedAbout()).toEqual([LAUNCH]);
    });

    it.each([
      ['the digest is off', 'MEETING_DIGEST_ENABLED'],
      ['the workers do not run in this process', 'MEETING_FILES_WORKER_ENABLED'],
    ])('does nothing when %s', async (_why, setting) => {
      settings[setting] = false;

      catchUp.onApplicationBootstrap();
      await pending.settled();

      expect(findStandings).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it('asks for nothing, and reads nothing, while the digest is off', async () => {
    settings['MEETING_DIGEST_ENABLED'] = false;

    await expect(catchUp.run()).resolves.toBe(0);

    expect(findStandings).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks about the meetings that look owed a digest, and passes over the rest unlocked', async () => {
    recordings = {
      [LAUNCH]: ['launch-1'],
      [PRICING]: ['pricing-1', 'pricing-2'],
      'meeting-queued': ['queued-1'],
      'meeting-generating': ['generating-1'],
      'meeting-failed': ['failed-1'],
      'meeting-current': ['current-1'],
    };
    findStandings.mockResolvedValue(
      new Map([
        // No row for the launch meeting; the pricing digest lacks its second recording.
        [PRICING, standing(READY, ['pricing-1'])],
        ['meeting-queued', standing(QUEUED)],
        ['meeting-generating', standing(GENERATING)],
        ['meeting-failed', standing(FAILED)],
        ['meeting-current', standing(READY, ['current-1'])],
      ]),
    );

    await expect(catchUp.run()).resolves.toBe(2);

    expect(askedAbout()).toEqual([LAUNCH, PRICING]);
    expect(announce.mock.calls).toEqual([[LAUNCH], [PRICING]]);
  });

  it('decides each meeting by its recordings as they are at its turn, not as the first look read them', async () => {
    // Transcribed, and its digest generated, between the first look and this meeting's turn.
    recordingsNow = { [LAUNCH]: ['launch-1', 'launch-2'] };

    await catchUp.run();

    expect(requestCatchUp).toHaveBeenCalledWith(LAUNCH, ['launch-1', 'launch-2']);
  });

  it('counts and announces only what it asked for', async () => {
    recordings = { [LAUNCH]: ['launch-1'], [PRICING]: ['pricing-1'] };
    // Under the lock the launch digest turned out to be queued already.
    requestCatchUp.mockImplementation(async (meetingId: string) => meetingId === PRICING);

    await expect(catchUp.run()).resolves.toBe(1);

    expect(announce.mock.calls).toEqual([[PRICING]]);
  });

  it('goes on to the next meeting when one cannot be asked for, and does not reject', async () => {
    recordings = { [LAUNCH]: ['launch-1'], [PRICING]: ['pricing-1'] };
    requestCatchUp.mockImplementation(async (meetingId: string) => {
      if (meetingId === LAUNCH) {
        throw new Error('connection lost');
      }

      return true;
    });

    await expect(catchUp.run()).resolves.toBe(1);

    expect(askedAbout()).toEqual([LAUNCH, PRICING]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[0]).toContain(LAUNCH);
  });

  it('asks for nothing, and does not reject, when the first look cannot be taken', async () => {
    findStandings.mockRejectedValue(new Error('connection lost'));

    await expect(catchUp.run()).resolves.toBe(0);

    expect(requestCatchUp).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    // An unread table is not an empty one: the error is the only line, and no count is said.
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([
    ['the process is shutting down', (): void => catchUp.onModuleDestroy()],
    [
      'the digest is switched off',
      (): void => {
        settings['MEETING_DIGEST_ENABLED'] = false;
      },
    ],
  ])('finishes the meeting in hand and starts no other once %s', async (_why, stop) => {
    recordings = { [LAUNCH]: ['launch-1'], [PRICING]: ['pricing-1'], [HIRING]: ['hiring-1'] };
    requestCatchUp.mockImplementation(async (meetingId: string) => {
      if (meetingId === LAUNCH) {
        stop();
      }

      return true;
    });

    await expect(catchUp.run()).resolves.toBe(1);

    expect(askedAbout()).toEqual([LAUNCH]);
    expect(announce.mock.calls).toEqual([[LAUNCH]]);
  });

  it('says how many meetings look owed a digest before it asks for any, and then how many it asked for', async () => {
    recordings = { [LAUNCH]: ['launch-1'], [PRICING]: ['pricing-1'] };
    const saidBeforeAsking: unknown[] = [];
    requestCatchUp.mockImplementation(async (meetingId: string) => {
      if (saidBeforeAsking.length === 0) {
        saidBeforeAsking.push(...logged.mock.calls.map(([message]) => message));
      }

      return meetingId === PRICING;
    });

    await catchUp.run();

    // Each is a paid request nobody made: the count is in the log while it can be acted on.
    expect(saidBeforeAsking).toEqual(['Digest catch-up: 2 meetings look owed a digest']);
    expect(logged.mock.calls.at(-1)?.[0]).toBe('Digest catch-up: asked for 1 of 2');
  });

  it('says that none is owed, in the one line a boot with nothing to catch up logs', async () => {
    findStandings.mockResolvedValue(new Map([[LAUNCH, standing(READY, ['launch-1'])]]));

    await catchUp.run();

    expect(logged.mock.calls).toEqual([['Digest catch-up: 0 meetings look owed a digest']]);
  });
});
