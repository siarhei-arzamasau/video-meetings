import { useApiSuite } from './utils/api-suite';
import { CLAIM_LEASE_SECONDS, useDigestClaimsSuite } from './utils/digest-claims-suite';
import {
  GENERATING,
  QUEUED,
  READY,
  FAILED,
  setMeetingDigestState,
} from './utils/meeting-digests-table';

/** More claimants than rows, and fewer than the connection pool holds, so all are in flight. */
const CLAIMANTS = 8;
const ROWS = 5;
const MINUTE_MS = 60_000;
/**
 * The request and the claim, run against the database: the unit specs stub Prisma, so this is
 * where the upsert's conflict clause and the claim's locking are what is under test. One
 * generation per meeting, whoever is racing — "no two claimants are handed the same row" —
 * and one more, not a lost one, for a request made while it runs. The writes that end a
 * claim are `meeting-digest-claim-writes.e2e-spec.ts`'s.
 */
describe('meeting digest requests and claims, against the database', () => {
  const suite = useApiSuite();
  const { digests, claims, newMeeting, rowOf, claimed } = useDigestClaimsSuite(suite);

  describe('a request', () => {
    it('makes the row, queued, and two at once are two revisions of it', async () => {
      const meetingId = await newMeeting();

      await Promise.all([digests().request(meetingId), digests().request(meetingId)]);

      await expect(rowOf(meetingId)).resolves.toMatchObject({
        status: QUEUED,
        requested_revision: 2,
        version: 2,
        attempts: 0,
      });
    });

    it.each([READY, FAILED])(
      'queues a %s digest afresh: no reason, no claims counted',
      async (status) => {
        const meetingId = await newMeeting();
        await digests().request(meetingId);
        await setMeetingDigestState(suite.prisma(), meetingId, {
          status,
          attempts: 4,
          failure_reason: 'It failed.',
        });

        await digests().request(meetingId);

        await expect(rowOf(meetingId)).resolves.toMatchObject({
          status: QUEUED,
          attempts: 0,
          failure_reason: null,
          leased_until: null,
          requested_revision: 2,
        });
      },
    );

    it('leaves a generation under way as it is, lease and count, and only moves the revision', async () => {
      const { meetingId, claim } = await claimed();
      const before = await rowOf(meetingId);

      await digests().request(meetingId);

      await expect(rowOf(meetingId)).resolves.toMatchObject({
        status: GENERATING,
        attempts: 1,
        leased_until: before?.leased_until,
        requested_revision: claim.requestedRevision + 1,
        version: (before?.version ?? 0) + 1,
      });
    });
  });

  describe('a claim', () => {
    it('hands each queued digest to exactly one of several racing workers', async () => {
      const meetingIds = await Promise.all(Array.from({ length: ROWS }, newMeeting));
      await Promise.all(meetingIds.map((meetingId) => digests().request(meetingId)));

      const taken = await Promise.all(
        Array.from({ length: CLAIMANTS }, () => claims().claimNext(CLAIM_LEASE_SECONDS)),
      );

      const won = taken.filter((claim) => claim !== null);
      expect(won.map(({ meetingId }) => meetingId).toSorted()).toEqual(meetingIds.toSorted());
      for (const claim of won) {
        expect(claim).toMatchObject({
          attempts: 1,
          requestedRevision: 1,
          previousStatus: QUEUED,
          leasedUntil: expect.any(Date),
        });
      }
    });

    it('takes only what is claimable: queued, or generating past its lease', async () => {
      const [queued, lapsed, held, ready] = await Promise.all(
        Array.from({ length: 4 }, newMeeting),
      );
      const seed = async (
        meetingId: string,
        status: string,
        leaseEndsInMs?: number,
      ): Promise<void> => {
        await digests().request(meetingId);
        await setMeetingDigestState(suite.prisma(), meetingId, {
          status,
          leased_until: leaseEndsInMs === undefined ? null : new Date(Date.now() + leaseEndsInMs),
        });
      };
      await seed(queued ?? '', QUEUED);
      await seed(lapsed ?? '', GENERATING, -MINUTE_MS);
      await seed(held ?? '', GENERATING, MINUTE_MS);
      await seed(ready ?? '', READY);

      const taken = await Promise.all(
        Array.from({ length: CLAIMANTS }, () => claims().claimNext(CLAIM_LEASE_SECONDS)),
      );

      const won = taken.filter((claim) => claim !== null);
      expect(won.map(({ meetingId }) => meetingId).toSorted()).toEqual([queued, lapsed].toSorted());
      expect(won.find(({ meetingId }) => meetingId === lapsed)?.previousStatus).toBe(GENERATING);
    });

    it('is renewed only by the lease it holds, and a renewal is not a new version', async () => {
      const { meetingId, claim } = await claimed();
      const before = await rowOf(meetingId);

      const renewed = await claims().renewLease(
        claim.id,
        claim.leasedUntil,
        CLAIM_LEASE_SECONDS * 2,
      );

      expect(renewed?.getTime()).toBeGreaterThan(claim.leasedUntil.getTime());
      await expect(
        claims().renewLease(claim.id, claim.leasedUntil, CLAIM_LEASE_SECONDS),
      ).resolves.toBeNull();
      await expect(rowOf(meetingId)).resolves.toMatchObject({ version: before?.version });
    });
  });
});
