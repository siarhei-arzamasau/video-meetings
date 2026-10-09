import { ConfigService } from '@nestjs/config';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { ClaudeAgentFailure } from '../../claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../../claude-agent/claude-agent.error';
import type { MeetingTranscripts } from '../../meeting-files/queries/find-meeting-transcripts.query';
import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { FindMeetingMemberIdsQuery } from '../../meetings/queries/find-meeting-member-ids.query';
import { FindUsersByIdsQuery } from '../../user/queries/find-users-by-ids.query';
import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
import { MeetingDigestAnnouncer } from '../services/meeting-digest-announcer';
import { NO_DIGEST_STATUS } from '../services/meeting-digest-claim-writes';
import { MeetingDigestClaimRepository } from '../services/meeting-digest-claim.repository';
import { MeetingDigestDeleteFollower } from '../services/meeting-digest-delete-follower';
import type { ClaimedDigest } from '../services/meeting-digest-claim.repository';
import { MeetingDigestGenerator } from '../services/meeting-digest-generator';
import type { GeneratedMeetingDigest } from '../services/meeting-digest-generator';
import type { DigestOwnerLinks } from '../services/meeting-digest-owner';
import {
  DIGEST_ID,
  DIGEST_MEETING_ID,
  FIRST_RECORDING_ID,
  SECOND_RECORDING_ID,
} from '../services/meeting-digest-record.fixture';
import { DigestStatus } from '../services/meeting-digest-status';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import type { StorableDigest } from './meeting-digest-run';
import { MEETING_DIGEST_WORKER, MeetingDigestWorker } from './meeting-digest-worker';

export const LEASE = new Date(Date.now() + 60_000);

/** A row the worker has just claimed for the first time, for the request numbered 2. */
export const CLAIMED: ClaimedDigest = {
  id: DIGEST_ID,
  meetingId: DIGEST_MEETING_ID,
  attempts: 1,
  leasedUntil: LEASE,
  requestedRevision: 2,
  previousStatus: DigestStatus.QUEUED,
};

/** What every write that ends `CLAIMED` is conditional on, the lease never having moved. */
export const HELD = { id: DIGEST_ID, lease: LEASE, requestedRevision: 2 };

export const TRANSCRIPTS: MeetingTranscripts = {
  withinLimit: true,
  transcripts: [
    { fileId: FIRST_RECORDING_ID, text: 'We ship on Friday.' },
    { fileId: SECOND_RECORDING_ID, text: 'Grace sends the release notes.' },
  ],
};

/** The meeting's transcribed recordings: the two `TRANSCRIPTS` were read from, still there. */
export const TRANSCRIBED: TranscribedRecording[] = TRANSCRIPTS.transcripts.map(({ fileId }) => ({
  id: fileId,
  uploaderId: '11111111-1111-4111-8111-111111111111',
}));

export const GENERATED: GeneratedMeetingDigest = {
  answer: {
    summary: 'The team agreed to ship on Friday.',
    actionItems: [{ description: 'Send the release notes.', ownerName: 'Grace' }],
    decisions: [{ description: 'Ship on Friday.' }],
  },
  model: 'claude-sonnet-5-5',
  costUsd: 0.0041,
  inputTokens: 3037,
  outputTokens: 300,
};

/** The participant `GENERATED` names as an owner, by her first name. */
const GRACE: UserDisplayName = {
  id: '22222222-2222-4222-8222-222222222222',
  displayName: 'Grace Hopper',
};

/** The meeting's host and its one participant. */
export const MEMBERS: UserDisplayName[] = [
  { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada Lovelace' },
  GRACE,
];

/** What matching `GENERATED`'s owners against `MEMBERS` finds: "Grace" is the participant. */
export const OWNER_LINKS: DigestOwnerLinks = new Map([['Grace', GRACE.id]]);

/** `GENERATED` as a run reports it for storing: one recording behind it, its owner linked. */
export const STORABLE: StorableDigest = {
  generated: GENERATED,
  sourceFileIds: [FIRST_RECORDING_ID],
  ownerLinks: OWNER_LINKS,
};

/** Words only the SDK says; nothing the worker stores may repeat them. */
export const SDK_WORDS = 'API Error: 529 {"type":"overloaded_error"} request_id=req_7f3a';

/**
 * A generator that honours its signal, as `ClaudeAgentService` does, and never answers
 * otherwise: hung up on, it rejects as that service would, with the signal's reason as cause.
 */
export const untilHungUp = (
  _transcripts: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<GeneratedMeetingDigest> =>
  new Promise((_resolve, reject) => {
    const hungUp = (): void =>
      reject(new ClaudeAgentError(ClaudeAgentFailure.FAILED, SDK_WORDS, { cause: signal.reason }));

    if (signal.aborted) {
      hungUp();
    } else {
      signal.addEventListener('abort', hungUp, { once: true });
    }
  });

/** Everything the worker reaches outside itself, as mocks a spec scripts and reads back. */
export interface DigestWorkerDoubles {
  claimNext: jest.Mock;
  renewLease: jest.Mock;
  complete: jest.Mock;
  fail: jest.Mock;
  release: jest.Mock;
  clear: jest.Mock;
  /**
   * The query bus. The worker dispatches four queries: the meeting's transcripts, which is
   * what a spec scripts with `mockResolvedValue`, and three once an answer is in hand, each
   * answered by a mock of its own whatever `execute` is scripted with — the meeting's
   * transcribed recordings, who is in the meeting, and what those members are called.
   */
  execute: jest.Mock;
  transcribed: jest.Mock;
  memberIds: jest.Mock;
  memberNames: jest.Mock;
  /** The generator, as a run calls it: the transcripts and the signal. */
  generate: jest.Mock;
  /** The meeting each generation was asked for — what the worker gives the generator first. */
  generatedFor: jest.Mock;
  /** `MeetingDigestAnnouncer.announce`: called with the meeting after every write that landed. */
  announce: jest.Mock;
  /** `MeetingDigestDeleteFollower.recheckStored`: the second look, after an answer is stored. */
  recheckStored: jest.Mock;
}

export function digestWorkerDoubles(): DigestWorkerDoubles {
  return {
    claimNext: jest.fn(),
    renewLease: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
    release: jest.fn(),
    clear: jest.fn(),
    execute: jest.fn(),
    transcribed: jest.fn(),
    memberIds: jest.fn(),
    memberNames: jest.fn(),
    generate: jest.fn(),
    generatedFor: jest.fn(),
    announce: jest.fn(),
    recheckStored: jest.fn(),
  };
}

/** One claimable digest whose generation succeeds and whose every write lands. */
export function resetDigestWorkerDoubles(doubles: DigestWorkerDoubles): void {
  doubles.claimNext.mockReset().mockResolvedValueOnce(CLAIMED).mockResolvedValue(null);
  doubles.renewLease.mockReset().mockResolvedValue(new Date(Date.now() + 30_000));
  doubles.complete.mockReset().mockResolvedValue(DigestStatus.READY);
  doubles.fail.mockReset().mockResolvedValue(DigestStatus.FAILED);
  doubles.release.mockReset().mockResolvedValue(true);
  doubles.clear.mockReset().mockResolvedValue(NO_DIGEST_STATUS);
  doubles.execute.mockReset().mockResolvedValue(TRANSCRIPTS);
  doubles.transcribed.mockReset().mockResolvedValue(TRANSCRIBED);
  doubles.memberIds.mockReset().mockResolvedValue(MEMBERS.map(({ id }) => id));
  doubles.memberNames.mockReset().mockResolvedValue(MEMBERS);
  doubles.generate.mockReset().mockResolvedValue(GENERATED);
  doubles.generatedFor.mockReset();
  doubles.announce.mockReset().mockResolvedValue(undefined);
  doubles.recheckStored.mockReset().mockResolvedValue(undefined);
}

const DEFAULTS: Record<string, unknown> = {
  MEETING_FILES_WORKER_ENABLED: false,
  MEETING_DIGEST_ENABLED: true,
  MEETING_FILES_LEASE_SECONDS: 30,
  MEETING_FILES_POLL_MS: 20,
};

export interface BuiltDigestWorker {
  worker: MeetingDigestWorker;
  pending: PendingDigestRequests;
}

/** `values` is read on every `get`, not copied, so a spec can change a setting in place. */
export async function buildDigestWorker(
  doubles: DigestWorkerDoubles,
  values: Record<string, unknown> = {},
): Promise<BuiltDigestWorker> {
  const { execute, transcribed, memberIds, memberNames, generate, announce, ...rest } = doubles;
  const { recheckStored, generatedFor, ...claims } = rest;
  // The meeting is taken off the front, so that `generate` is scripted and asserted with
  // what a run hands it, here and in the run's own specs alike.
  const generateFor = (
    meetingId: string,
    transcripts: ReadonlyArray<string>,
    signal: AbortSignal,
  ): unknown => {
    generatedFor(meetingId);

    return generate(transcripts, signal) as unknown;
  };
  // By class, so that scripting the transcripts never scripts another query with them.
  const answeredApart: Array<[new (...args: never[]) => unknown, jest.Mock]> = [
    [FindTranscribedRecordingsQuery, transcribed],
    [FindMeetingMemberIdsQuery, memberIds],
    [FindUsersByIdsQuery, memberNames],
  ];
  const dispatch = (query: unknown): unknown =>
    (answeredApart.find(([queryClass]) => query instanceof queryClass)?.[1] ?? execute)(query);
  const moduleRef = await Test.createTestingModule({
    providers: [
      MeetingDigestWorker,
      { provide: MEETING_DIGEST_WORKER, useExisting: MeetingDigestWorker },
      PendingDigestRequests,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, fallback: unknown) => values[key] ?? DEFAULTS[key] ?? fallback,
        },
      },
      { provide: MeetingDigestClaimRepository, useValue: claims },
      { provide: QueryBus, useValue: { execute: dispatch } },
      { provide: MeetingDigestGenerator, useValue: { generate: generateFor } },
      { provide: MeetingDigestAnnouncer, useValue: { announce } },
      { provide: MeetingDigestDeleteFollower, useValue: { recheckStored } },
    ],
  }).compile();

  return {
    worker: moduleRef.get(MEETING_DIGEST_WORKER),
    pending: moduleRef.get(PendingDigestRequests),
  };
}
