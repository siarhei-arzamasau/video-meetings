import { MEETING_DIGEST_FAILED_MESSAGE } from '@repo/shared';
import type {
  MeetingDigest,
  MeetingDigestContent,
  MeetingDigestOwner,
  MeetingFile,
} from '@repo/shared';

/** What the section says while a generation is on its way, and when one ended badly. */
export const DIGEST_QUEUED_LABEL = 'Digest queued';
export const DIGEST_GENERATING_LABEL = 'Generating digest…';
export const DIGEST_FAILED_LABEL = 'Digest failed';
/** Beside a digest that a newer recording is not part of, until its replacement lands. */
export const DIGEST_OUT_OF_DATE_LABEL = 'Out of date';

/** An empty list is a result, said under its heading — never a heading left out. */
export const NO_ACTION_ITEMS_LABEL = 'No action items were identified';
export const NO_DECISIONS_LABEL = 'No decisions were recorded';
/** The owner of an action item the transcripts named nobody for. */
export const UNASSIGNED_LABEL = 'Unassigned';

/** The note every shown digest carries: who wrote it, from what, and how far to trust it. */
export const DIGEST_AI_NOTE =
  "AI-generated from the transcripts of this meeting's recordings. It may contain mistakes.";

/** Where a digest came from, which decides what an equal version means. */
export type DigestSource = 'fetch' | 'event';

/**
 * Which of two digests the page keeps: the one it holds, or the one that has just arrived.
 *
 * **The higher version, and this is the whole of how an event is put in order against a
 * fetch.** The API moves a digest's version with every change to what it answers, so a slow
 * fetch that lands after an event cannot put a digest back to the status that event had
 * already moved it on from — the one thing the files list needs a replay buffer for, because
 * a file carries no version.
 *
 * **Of two with the same version, a fetch wins and an event does not.** Two changes reach the
 * API's answer without moving the version: a linked owner's new display name, and an
 * `availableAction` that left with the meeting's last recording. Neither is announced, so
 * only a fetch can bring either, and it must be taken over an equal digest already held. An
 * event of a version already held is the same digest announced twice — two writes close
 * together are — and replacing the held one with it would only be a render.
 *
 * A digest of another meeting is never compared: it replaces whatever is held.
 */
export function laterDigest(
  held: MeetingDigest | null,
  incoming: MeetingDigest,
  from: DigestSource,
): MeetingDigest {
  if (held === null || held.meetingId !== incoming.meetingId) {
    return incoming;
  }

  const isLater =
    from === 'fetch' ? incoming.version >= held.version : incoming.version > held.version;

  return isLater ? incoming : held;
}

/** Queued or being generated: a digest whose end somebody may still be waiting to see. */
export function isDigestUnderWay(digest: MeetingDigest | null): boolean {
  return digest?.status === 'queued' || digest?.status === 'generating';
}

/**
 * The recordings a digest of the meeting would be built from, as the page's own list has
 * them: transcribed, in a stable order. The API decides what a digest covers; the page only
 * needs to notice that this changed.
 */
export function transcribedRecordingIds(
  files: ReadonlyArray<Pick<MeetingFile, 'id' | 'transcriptionStatus'>>,
): string[] {
  return files
    .filter(({ transcriptionStatus }) => transcriptionStatus === 'transcribed')
    .map(({ id }) => id)
    .toSorted();
}

/** Where the latest generation stands, when that is something to say. */
export type DigestStatusLine =
  | { kind: 'queued'; label: string }
  | { kind: 'generating'; label: string }
  | { kind: 'failed'; label: string; reason: string };

export type DigestOwnerKind = 'participant' | 'name' | 'unassigned';

export interface DigestActionItemLine {
  id: string;
  description: string;
  /** A participant's display name, a name as it was spoken, or `UNASSIGNED_LABEL`. */
  owner: string;
  ownerKind: DigestOwnerKind;
}

export interface DigestContentView {
  summary: string;
  actionItems: ReadonlyArray<DigestActionItemLine>;
  /** What to say under the heading instead of a list, when the list is empty. */
  noActionItems: string | null;
  decisions: ReadonlyArray<{ id: string; description: string }>;
  noDecisions: string | null;
  generatedAt: string;
  /** A transcribed recording is not part of this digest: shown, and marked. */
  outOfDate: boolean;
  note: string;
}

export interface DigestPresentation {
  /** Absent for a digest that is simply there: `ready` is said by showing it. */
  status: DigestStatusLine | null;
  /** The last digest that was stored, while every recording it was built from exists. */
  content: DigestContentView | null;
}

/**
 * What the digest section shows for a digest, or `null` when it shows nothing at all.
 *
 * **A status and content are two things, shown side by side.** The status is where the
 * latest generation stands; the content is what the last successful one stored. So an
 * out-of-date digest stays readable beside "Generating digest…", and beside "Digest failed"
 * when its replacement could not be made.
 *
 * **Nothing at all without one of the two** — a meeting with no transcribed recording, a
 * digest withdrawn with a recording and not yet replaced, and a page that has not heard from
 * the API yet all look the same: no section, rather than an empty frame around nothing.
 *
 * Every string of the content is handed on exactly as it came. It is a model's writing about
 * what was said in a recording, so it is text for React to escape and never markup.
 */
export function digestPresentation(digest: MeetingDigest | null): DigestPresentation | null {
  if (digest === null) {
    return null;
  }

  const status = statusLineOf(digest);
  const content = digest.content === undefined ? null : contentViewOf(digest.content);

  return status === null && content === null ? null : { status, content };
}

function statusLineOf({ status, failureReason }: MeetingDigest): DigestStatusLine | null {
  switch (status) {
    case 'queued':
      return { kind: 'queued', label: DIGEST_QUEUED_LABEL };
    case 'generating':
      return { kind: 'generating', label: DIGEST_GENERATING_LABEL };
    case 'failed':
      return {
        kind: 'failed',
        label: DIGEST_FAILED_LABEL,
        reason: failureReason ?? MEETING_DIGEST_FAILED_MESSAGE,
      };
    case 'ready':
    case undefined:
      return null;
  }
}

function contentViewOf(content: MeetingDigestContent): DigestContentView {
  return {
    summary: content.summary,
    actionItems: content.actionItems.map(({ id, description, owner }) => ({
      id,
      description,
      ...ownerLineOf(owner),
    })),
    noActionItems: content.actionItems.length === 0 ? NO_ACTION_ITEMS_LABEL : null,
    decisions: content.decisions.map(({ id, description }) => ({ id, description })),
    noDecisions: content.decisions.length === 0 ? NO_DECISIONS_LABEL : null,
    generatedAt: content.generatedAt,
    outOfDate: content.outOfDate,
    note: DIGEST_AI_NOTE,
  };
}

/**
 * Who an action item is shown as belonging to. The API decides which of the three it is —
 * a member of the meeting, a name nobody in it answers to, or nobody — and this only words it.
 */
function ownerLineOf(
  owner: MeetingDigestOwner | undefined,
): Pick<DigestActionItemLine, 'owner' | 'ownerKind'> {
  if (owner === undefined) {
    return { owner: UNASSIGNED_LABEL, ownerKind: 'unassigned' };
  }

  return owner.kind === 'participant'
    ? { owner: owner.displayName, ownerKind: 'participant' }
    : { owner: owner.name, ownerKind: 'name' };
}
