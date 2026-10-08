import type {
  MeetingDigest,
  MeetingDigestContent,
  MeetingDigestOwner,
  MeetingDigestStatus,
} from '@repo/shared';

import { DigestStatus } from './meeting-digest-status';

export interface MeetingDigestActionItemRecord {
  id: string;
  position: number;
  description: string;
  ownerName: string | null;
}

export interface MeetingDigestDecisionRecord {
  id: string;
  position: number;
  description: string;
}

/**
 * The stored digest with what the last successful generation left under it, spelled out so
 * `toMeetingDigest` is unit-testable without the generated client. The Prisma model, loaded
 * with its three child tables, satisfies it structurally.
 */
export interface MeetingDigestRecord {
  id: string;
  meetingId: string;
  status: DigestStatus | null;
  failureReason: string | null;
  version: number;
  summary: string | null;
  generatedAt: Date | null;
  actionItems: ReadonlyArray<MeetingDigestActionItemRecord>;
  decisions: ReadonlyArray<MeetingDigestDecisionRecord>;
  sources: ReadonlyArray<{ meetingFileId: string }>;
}

/**
 * The stored status in the wire's words: UPPER_CASE in the database, lower-case in
 * `@repo/shared`. The one place that translates — a `Record`, so a status added to either
 * side without its word here does not compile.
 */
const WIRE_STATUS: Record<DigestStatus, MeetingDigestStatus> = {
  [DigestStatus.QUEUED]: 'queued',
  [DigestStatus.GENERATING]: 'generating',
  [DigestStatus.READY]: 'ready',
  [DigestStatus.FAILED]: 'failed',
};

/**
 * Row → wire shape, for a meeting the caller is already known to see.
 *
 * `transcribedFileIds` are the meeting's recordings that are transcribed *now*, and both of
 * the PRD's rules about recordings are decided from them here, on every read, rather than
 * kept true by whoever deletes or adds one:
 *
 * - **content is returned only while every recording it was built from is still one of
 *   them** — a deleted recording's words must not stay readable through the digest, whether
 *   or not anything has yet reacted to the delete;
 * - **content is `outOfDate` when one of them is not among its sources** — a recording
 *   transcribed since, with the setting on or off.
 *
 * Everything the worker owns stays behind — the lease, the claim count, the revision — and
 * so does what a generation cost, which is in the log and in no row. Optional fields are
 * absent rather than null, so the JSON matches the shared interface exactly.
 */
export function toMeetingDigest(
  meetingId: string,
  record: MeetingDigestRecord | null,
  transcribedFileIds: ReadonlyArray<string>,
): MeetingDigest {
  if (record === null) {
    return { meetingId, version: 0 };
  }

  const content = contentOf(record, new Set(transcribedFileIds));
  const failed = record.status === DigestStatus.FAILED;

  return {
    meetingId,
    version: record.version,
    ...(record.status !== null ? { status: WIRE_STATUS[record.status] } : {}),
    // Only when failed: a reason left on a row that was queued again must not show.
    ...(failed && record.failureReason !== null ? { failureReason: record.failureReason } : {}),
    ...(content !== null ? { content } : {}),
  };
}

function contentOf(
  record: MeetingDigestRecord,
  transcribed: ReadonlySet<string>,
): MeetingDigestContent | null {
  if (record.summary === null || record.generatedAt === null) {
    return null;
  }

  const sources = new Set(record.sources.map(({ meetingFileId }) => meetingFileId));
  const everySourceIsStillThere = [...sources].every((fileId) => transcribed.has(fileId));

  // No sources at all is not "nothing was deleted": a digest is never generated from none.
  if (sources.size === 0 || !everySourceIsStillThere) {
    return null;
  }

  return {
    summary: record.summary,
    actionItems: byPosition(record.actionItems).map(toActionItem),
    decisions: byPosition(record.decisions).map(({ id, description }) => ({ id, description })),
    generatedAt: record.generatedAt.toISOString(),
    outOfDate: [...transcribed].some((fileId) => !sources.has(fileId)),
  };
}

/**
 * An owner is a name as it was spoken, or absent — unassigned. Linking a name to a member of
 * the meeting comes later, and is the API's decision when it does.
 */
function toActionItem({
  id,
  description,
  ownerName,
}: MeetingDigestActionItemRecord): MeetingDigestContent['actionItems'][number] {
  const owner: MeetingDigestOwner | null =
    ownerName === null ? null : { kind: 'name', name: ownerName };

  return owner === null ? { id, description } : { id, description, owner };
}

function byPosition<T extends { position: number }>(rows: ReadonlyArray<T>): T[] {
  return rows.toSorted((left, right) => left.position - right.position);
}
