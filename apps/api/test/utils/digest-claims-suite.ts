import { MeetingDigestClaimRepository } from '../../src/modules/meeting-digests/services/meeting-digest-claim.repository';
import type { ClaimedDigest } from '../../src/modules/meeting-digests/services/meeting-digest-claim.repository';
import type { HeldDigest } from '../../src/modules/meeting-digests/services/meeting-digest-claim-writes';
import { MeetingDigestRepository } from '../../src/modules/meeting-digests/services/meeting-digest.repository';
import type { ApiSuite } from './api-suite';
import { EMAIL } from './fixtures';
import { findMeetingDigestRow } from './meeting-digests-table';
import type { MeetingDigestRow } from './meeting-digests-table';
import { insertMeetingFileRow } from './meeting-files-table';
import { createMeeting, registerUser } from './meeting-files-suite';
import type { RegisteredUser } from './meeting-files-suite';

export const CLAIM_LEASE_SECONDS = 60;

/** What a write that ends `claim` is conditional on, the lease never having been renewed. */
export const heldBy = ({ id, leasedUntil, requestedRevision }: ClaimedDigest): HeldDigest => ({
  id,
  lease: leasedUntil,
  requestedRevision,
});

export interface DigestClaimsSuite {
  digests(): MeetingDigestRepository;
  claims(): MeetingDigestClaimRepository;
  host(): RegisteredUser;
  /** A new meeting hosted by the suite's user; its id. */
  newMeeting(): Promise<string>;
  rowOf(meetingId: string): Promise<MeetingDigestRow | null>;
  /** A new meeting whose digest was asked for once and then claimed. */
  claimed(): Promise<{ meetingId: string; claim: ClaimedDigest }>;
  /** A transcribed recording's row, for a digest's source to point at; its id. */
  recordingOf(meetingId: string): Promise<string>;
}

/**
 * The two digest repositories of the suite's application, driven directly: the specs that
 * use this are about the statements themselves, raced and run against the real database,
 * which is the one thing a unit spec over a stubbed client cannot show.
 *
 * Call it at describe scope, after `useApiSuite`: it registers one user before each test.
 */
export function useDigestClaimsSuite(suite: ApiSuite): DigestClaimsSuite {
  let host: RegisteredUser | undefined;

  beforeEach(async () => {
    host = await registerUser(suite, EMAIL);
  });

  const hostOf = (): RegisteredUser => {
    if (host === undefined) {
      throw new Error('The host is registered before each test — read it inside one');
    }

    return host;
  };
  const digests = (): MeetingDigestRepository => suite.app().get(MeetingDigestRepository);
  const claims = (): MeetingDigestClaimRepository => suite.app().get(MeetingDigestClaimRepository);
  const newMeeting = async (): Promise<string> => (await createMeeting(suite, hostOf())).id;

  return {
    digests,
    claims,
    host: hostOf,
    newMeeting,
    rowOf: (meetingId) => findMeetingDigestRow(suite.prisma(), meetingId),
    claimed: async () => {
      const meetingId = await newMeeting();
      await digests().request(meetingId);
      const claim = await claims().claimNext(CLAIM_LEASE_SECONDS);

      // Each test starts from empty tables, so the only claimable row is the one just made.
      if (claim?.meetingId !== meetingId) {
        throw new Error('Expected the digest just requested to be the one claimed');
      }

      return { meetingId, claim };
    },
    recordingOf: (meetingId) =>
      insertMeetingFileRow(suite.prisma(), {
        meeting_id: meetingId,
        uploader_id: hostOf().id,
        content_type: 'audio/mpeg',
        status: 'ready',
      }),
  };
}
