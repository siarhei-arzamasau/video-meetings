import type {
  MeetingDigest,
  MeetingDigestContent,
  MeetingDigestOwner,
  MeetingDigestStatus,
} from '@repo/shared';

import { requestabilityOf } from './meeting-digest-action';
import { DigestStatus } from './meeting-digest-status';

export interface MeetingDigestActionItemRecord {
  id: string;
  position: number;
  description: string;
  /** The owner as the transcripts named them, or `null` when they named nobody. */
  ownerName: string | null;
  /** The member of the meeting that name was matched to, or `null` when it was to nobody. */
  ownerId: string | null;
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
 * `ownerNames` is what each linked owner is called *now*, by user id — read when the digest
 * is, so a member who has changed their name is shown under the new one with nothing
 * generated and nothing rewritten.
 *
 * `generationEnabled` is the deployment's setting, and all it decides is `availableAction`:
 * what "generate now" would do for the digest as it stands, by the rule the request route
 * refuses by (`requestabilityOf`), and absent whenever the setting is off — nothing is generated
 * then, so nothing is offered. It is the same for every reader; who may ask is the route's.
 *
 * Everything the worker owns stays behind — the lease, the claim count, the revision — and
 * so does what a generation cost, which is in the log and in no row. Optional fields are
 * absent rather than null, so the JSON matches the shared interface exactly.
 */
export function toMeetingDigest(
  meetingId: string,
  record: MeetingDigestRecord | null,
  transcribedFileIds: ReadonlyArray<string>,
  ownerNames: ReadonlyMap<string, string>,
  generationEnabled: boolean,
): MeetingDigest {
  const transcribed = new Set(transcribedFileIds);
  const request = requestabilityOf(record, transcribed);
  const availableAction =
    generationEnabled && request.allowed ? { availableAction: request.action } : {};

  if (record === null) {
    return { meetingId, version: 0, ...availableAction };
  }

  const content = contentOf(record, transcribed, ownerNames);
  const failed = record.status === DigestStatus.FAILED;

  return {
    meetingId,
    version: record.version,
    ...(record.status !== null ? { status: WIRE_STATUS[record.status] } : {}),
    // Only when failed: a reason left on a row that was queued again must not show.
    ...(failed && record.failureReason !== null ? { failureReason: record.failureReason } : {}),
    ...(content !== null ? { content } : {}),
    ...availableAction,
  };
}

function contentOf(
  record: MeetingDigestRecord,
  transcribed: ReadonlySet<string>,
  ownerNames: ReadonlyMap<string, string>,
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
    actionItems: byPosition(record.actionItems).map((item) => toActionItem(item, ownerNames)),
    decisions: byPosition(record.decisions).map(({ id, description }) => ({ id, description })),
    generatedAt: record.generatedAt.toISOString(),
    outOfDate: [...transcribed].some((fileId) => !sources.has(fileId)),
  };
}

function toActionItem(
  { id, description, ownerName, ownerId }: MeetingDigestActionItemRecord,
  ownerNames: ReadonlyMap<string, string>,
): MeetingDigestContent['actionItems'][number] {
  const owner = ownerOf(ownerName, ownerId, ownerNames);

  return owner === null ? { id, description } : { id, description, owner };
}

/**
 * One of the PRD's three: a participant, under the name they go by now; a name as it was
 * spoken; or nobody — unassigned, which is the owner being absent.
 *
 * **A link whose member has no name to show falls back to the spoken name**, rather than to
 * a participant with a blank one: the account was deleted between the two reads, and the
 * item is still somebody's. The id of a member is the only thing about them that is served
 * beside their display name — never an address.
 */
function ownerOf(
  ownerName: string | null,
  ownerId: string | null,
  ownerNames: ReadonlyMap<string, string>,
): MeetingDigestOwner | null {
  const displayName = ownerId === null ? undefined : ownerNames.get(ownerId);

  if (ownerId !== null && displayName !== undefined) {
    return { kind: 'participant', userId: ownerId, displayName };
  }

  return ownerName === null ? null : { kind: 'name', name: ownerName };
}

function byPosition<T extends { position: number }>(rows: ReadonlyArray<T>): T[] {
  return rows.toSorted((left, right) => left.position - right.position);
}
