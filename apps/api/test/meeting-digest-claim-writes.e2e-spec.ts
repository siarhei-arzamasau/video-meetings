import { NO_DIGEST_STATUS } from '../src/modules/meeting-digests/services/meeting-digest-claim-writes';
import type { ClaimedDigest } from '../src/modules/meeting-digests/services/meeting-digest-claim.repository';
import { NO_OWNER_LINKS } from '../src/modules/meeting-digests/services/meeting-digest-owner';
import { useApiSuite } from './utils/api-suite';
import { CLAIM_LEASE_SECONDS, heldBy, useDigestClaimsSuite } from './utils/digest-claims-suite';
import {
  FAILED,
  GENERATING,
  QUEUED,
  READY,
  findMeetingDigestContentRows,
  setMeetingDigestState,
} from './utils/meeting-digests-table';

/** These writes are about the claim: no owner of theirs is matched to a member. */
const NOBODY_LINKED = { ownerLinks: NO_OWNER_LINKS };

const ANSWER = {
  summary: 'The launch moves to April.',
  actionItems: [{ description: 'Rewrite the emails.', ownerName: 'Alice Johnson' }],
  decisions: [{ description: 'Launch on the fifteenth of April.' }],
};

/**
 * The writes that end a digest claim, run against the database: the edge table, with a real
 * row under each edge. Each is conditional on the lease the caller holds, and the two that
 * settle a generation on the request it was claimed for still being the latest.
 */
describe('the write that ends a meeting digest claim, against the database', () => {
  const suite = useApiSuite();
  const { digests, claims, rowOf, claimed, recordingOf } = useDigestClaimsSuite(suite);

  it('stores the digest as ready, and replaces what an earlier one stored', async () => {
    const { meetingId, claim } = await claimed();
    const [first, second] = [await recordingOf(meetingId), await recordingOf(meetingId)];
    await expect(
      claims().complete(heldBy(claim), {
        ...NOBODY_LINKED,
        answer: ANSWER,
        sourceFileIds: [first],
      }),
    ).resolves.toBe(READY);

    await digests().request(meetingId);
    const again = await claims().claimNext(CLAIM_LEASE_SECONDS);
    const shorter = { summary: 'Shorter.', actionItems: [], decisions: [] };
    await claims().complete(heldBy(again as ClaimedDigest), {
      ...NOBODY_LINKED,
      answer: shorter,
      sourceFileIds: [first, second],
    });

    await expect(rowOf(meetingId)).resolves.toMatchObject({ status: READY, summary: 'Shorter.' });
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toEqual({
      actionItems: [],
      decisions: [],
      sources: [first, second].toSorted(),
    });
  });

  it('queues the digest again, content kept, when a request was made meanwhile', async () => {
    const { meetingId, claim } = await claimed();
    const source = await recordingOf(meetingId);
    await digests().request(meetingId);

    await expect(
      claims().complete(heldBy(claim), {
        ...NOBODY_LINKED,
        answer: ANSWER,
        sourceFileIds: [source],
      }),
    ).resolves.toBe(QUEUED);

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
      summary: ANSWER.summary,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toMatchObject({
      actionItems: [
        { description: 'Rewrite the emails.', owner_name: 'Alice Johnson', owner_id: null },
      ],
      sources: [source],
    });
  });

  it('fails with the reason, or queues without it when a request was made meanwhile', async () => {
    const failed = await claimed();
    await expect(claims().fail(heldBy(failed.claim), 'It failed.')).resolves.toBe(FAILED);
    await expect(rowOf(failed.meetingId)).resolves.toMatchObject({
      status: FAILED,
      failure_reason: 'It failed.',
      attempts: 1,
    });

    const overtaken = await claimed();
    await digests().request(overtaken.meetingId);
    await expect(claims().fail(heldBy(overtaken.claim), 'It failed.')).resolves.toBe(QUEUED);
    await expect(rowOf(overtaken.meetingId)).resolves.toMatchObject({
      status: QUEUED,
      failure_reason: null,
      attempts: 0,
    });
  });

  it('releases a claim uncounted, back to queued', async () => {
    const { meetingId, claim } = await claimed();

    await expect(claims().release(claim.id, claim.leasedUntil)).resolves.toBe(true);

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
    });
  });

  it('clears a claim to no status at all, and the row and its version stay', async () => {
    const { meetingId, claim } = await claimed();
    const before = await rowOf(meetingId);

    await expect(claims().clear(heldBy(claim))).resolves.toBe(NO_DIGEST_STATUS);

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: null,
      attempts: 0,
      leased_until: null,
      version: (before?.version ?? 0) + 1,
    });
    await expect(claims().claimNext(CLAIM_LEASE_SECONDS)).resolves.toBeNull();
  });

  it('queues the digest instead of clearing it when a request was made meanwhile', async () => {
    // The claim read the meeting's transcripts and found none. A recording transcribed after
    // that read asks for a digest while the row is still generating: only the revision moves.
    const { meetingId, claim } = await claimed();
    await digests().request(meetingId);

    await expect(claims().clear(heldBy(claim))).resolves.toBe(QUEUED);

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
      failure_reason: null,
    });
    // Which is the point: the recording that asked is generated from, not forgotten.
    await expect(claims().claimNext(CLAIM_LEASE_SECONDS)).resolves.toMatchObject({
      meetingId,
      requestedRevision: 2,
    });
  });

  it('writes nothing under a lease it has lost', async () => {
    const { meetingId, claim } = await claimed();
    // Reclaimed by another worker after a lapse: the row's lease is no longer this one.
    await setMeetingDigestState(suite.prisma(), meetingId, { leased_until: new Date(0) });
    const stale = heldBy(claim);

    await expect(
      claims().complete(stale, { ...NOBODY_LINKED, answer: ANSWER, sourceFileIds: [] }),
    ).resolves.toBeNull();
    await expect(claims().fail(stale, 'It failed.')).resolves.toBeNull();
    await expect(claims().release(stale.id, stale.lease)).resolves.toBe(false);
    await expect(claims().clear(stale)).resolves.toBeNull();

    await expect(rowOf(meetingId)).resolves.toMatchObject({
      status: GENERATING,
      summary: null,
      failure_reason: null,
    });
  });
});
