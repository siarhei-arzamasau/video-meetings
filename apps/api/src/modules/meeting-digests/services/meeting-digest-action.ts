import type { MeetingDigestAction } from '@repo/shared';

import { DigestStatus } from './meeting-digest-status';

/**
 * What of a stored digest decides whether a generation may be asked for by hand: where its
 * latest generation stands, whether anything is stored under it, and which recordings that
 * was built from. `MeetingDigestRecord` satisfies it, and so does the row a request has
 * locked together with its sources.
 */
export interface DigestStanding {
  status: DigestStatus | null;
  /** `null` until a generation has succeeded, and again once a delete removed its content. */
  summary: string | null;
  sources: ReadonlyArray<{ meetingFileId: string }>;
}

/** Why "generate now" is refused for a digest as it stands. */
export const DigestRequestRefusal = {
  /** The meeting has no transcribed recording: there is nothing to generate from. */
  NO_RECORDING: 'NO_RECORDING',
  /** A generation is queued or running, and will cover every recording there is. */
  UNDER_WAY: 'UNDER_WAY',
  /** The stored digest was built from exactly the recordings transcribed now. */
  CURRENT: 'CURRENT',
} as const;

export type DigestRequestRefusal = (typeof DigestRequestRefusal)[keyof typeof DigestRequestRefusal];

const { QUEUED, GENERATING, FAILED } = DigestStatus;

/** A generation is waiting or running: nothing may be asked for, whatever else is true. */
export function isUnderWay(status: DigestStatus | null | undefined): boolean {
  return status === QUEUED || status === GENERATING;
}

/**
 * Whether what is stored is the digest of the recordings transcribed now — every one of
 * them, and no other. The two halves are the read's two rules: a source that is gone means
 * the content is withheld, and a recording that is not a source means it is out of date.
 */
function isCurrent(standing: DigestStanding, transcribed: ReadonlySet<string>): boolean {
  if (standing.summary === null || standing.sources.length === 0) {
    return false;
  }

  const sources = new Set(standing.sources.map(({ meetingFileId }) => meetingFileId));

  return sources.size === transcribed.size && [...sources].every((id) => transcribed.has(id));
}

/** Whether "generate now" is allowed for a digest as it stands, and under which name. */
export type DigestRequestability =
  | { allowed: true; action: MeetingDigestAction }
  | { allowed: false; refusal: DigestRequestRefusal };

const refused = (refusal: DigestRequestRefusal): DigestRequestability => ({
  allowed: false,
  refusal,
});

/**
 * Whether a generation may be asked for by hand. `standing` is `null` for a meeting that
 * has no digest row.
 *
 * **The one rule behind both halves of "generate now"**: `availableAction` is what the read
 * reports where this allows, and the request is refused where it does not — so the control
 * a page shows and the answer the route gives cannot come to disagree.
 *
 * - **No transcribed recording refuses everything**, a failed digest included: a generation
 *   would be claimed, find nothing to send, and clear the status.
 * - **A failed digest may always be tried again** — Retry — whatever is stored under it. The
 *   content is what the last _successful_ generation left; the failure is the latest one's.
 * - **Anything else may be asked for — Generate — unless it is current**: no row, no status,
 *   or `READY` over content that has lost a recording or does not cover one. The last is the
 *   recording transcribed while the setting was off, which nothing else will ever pick up.
 */
export function requestabilityOf(
  standing: DigestStanding | null,
  transcribed: ReadonlySet<string>,
): DigestRequestability {
  if (transcribed.size === 0) {
    return refused(DigestRequestRefusal.NO_RECORDING);
  }

  if (standing?.status === FAILED) {
    return { allowed: true, action: 'retry' };
  }

  if (isUnderWay(standing?.status)) {
    return refused(DigestRequestRefusal.UNDER_WAY);
  }

  return standing !== null && isCurrent(standing, transcribed)
    ? refused(DigestRequestRefusal.CURRENT)
    : { allowed: true, action: 'generate' };
}
