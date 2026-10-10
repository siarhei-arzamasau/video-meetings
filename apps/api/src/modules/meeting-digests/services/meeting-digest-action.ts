import { DigestStatus } from './meeting-digest-status';

/**
 * What of a stored digest decides whether a generation may be asked for: where its latest
 * generation stands, whether anything is stored under it, and which recordings that was
 * built from. `MeetingDigestRecord` satisfies it, and so does the row a request has locked
 * together with its sources.
 */
export interface DigestStanding {
  status: DigestStatus | null;
  /** `null` until a generation has succeeded, and again once a delete removed its content. */
  summary: string | null;
  sources: ReadonlyArray<{ meetingFileId: string }>;
}

/**
 * Who a generation may be asked for by, when a recording did not ask. A digest as it stands
 * allows one of the two at most, and each has one caller.
 */
export const DigestRequestKind = {
  /** A person's: the latest generation failed, and its Retry is the one request made by hand. */
  RETRY: 'RETRY',
  /** The catch-up's: the meeting is owed a digest that nothing else is going to ask for. */
  CATCH_UP: 'CATCH_UP',
} as const;

export type DigestRequestKind = (typeof DigestRequestKind)[keyof typeof DigestRequestKind];

/** Why a generation may not be asked for, for a digest as it stands. */
export const DigestRequestRefusal = {
  /** The meeting has no transcribed recording: there is nothing to generate from. */
  NO_RECORDING: 'NO_RECORDING',
  /**
   * A generation is queued or running. One that is queued will read every recording there
   * is when it is claimed; one that is running read them when it was, and a recording
   * transcribed since has asked for one more after it.
   */
  UNDER_WAY: 'UNDER_WAY',
  /** The stored digest was built from exactly the recordings transcribed now. */
  CURRENT: 'CURRENT',
  /**
   * A generation may be asked for, by the other kind of caller: a digest that has not failed
   * is not a person's to ask for, and one that has is left for its Retry.
   */
  OTHER_KIND: 'OTHER_KIND',
} as const;

export type DigestRequestRefusal = (typeof DigestRequestRefusal)[keyof typeof DigestRequestRefusal];

const { QUEUED, GENERATING, FAILED } = DigestStatus;

/** A generation is waiting or running: nothing may be asked for, whatever else is true. */
function isUnderWay(status: DigestStatus | null | undefined): boolean {
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

/** Whether a generation may be asked for, for a digest as it stands, and by which caller. */
export type DigestRequestability =
  | { allowed: true; kind: DigestRequestKind }
  | { allowed: false; refusal: DigestRequestRefusal };

const refused = (refusal: DigestRequestRefusal): DigestRequestability => ({
  allowed: false,
  refusal,
});

/**
 * Whether a generation may be asked for when no recording asked, and by which caller.
 * `standing` is `null` for a meeting that has no digest row.
 *
 * **The one rule behind everything that asks without a recording**: the read reports
 * `availableAction` where this allows a retry, the retry route refuses where it does not,
 * and the catch-up asks where this says a digest is owed — so the control a page shows, the
 * answer the route gives, and what a boot queues cannot come to disagree.
 *
 * - **No transcribed recording refuses everything**, a failed digest included: a generation
 *   would be claimed, find nothing to send, and clear the status.
 * - **A failed digest is a person's to try again** — Retry — whatever is stored under it.
 *   The content is what the last _successful_ generation left; the failure is the latest
 *   one's. It is never the catch-up's: that would be a paid request retried at every boot.
 * - **Anything else is owed a digest — the catch-up's — unless it is under way or current**:
 *   no row, no status, or `READY` over content that has lost a recording or does not cover
 *   one. The last is the recording transcribed while the setting was off, which nothing
 *   else will ever pick up. It is never a person's: nobody has to ask for it.
 */
export function requestabilityOf(
  standing: DigestStanding | null,
  transcribed: ReadonlySet<string>,
): DigestRequestability {
  if (transcribed.size === 0) {
    return refused(DigestRequestRefusal.NO_RECORDING);
  }

  if (standing?.status === FAILED) {
    return { allowed: true, kind: DigestRequestKind.RETRY };
  }

  if (isUnderWay(standing?.status)) {
    return refused(DigestRequestRefusal.UNDER_WAY);
  }

  return standing !== null && isCurrent(standing, transcribed)
    ? refused(DigestRequestRefusal.CURRENT)
    : { allowed: true, kind: DigestRequestKind.CATCH_UP };
}

/**
 * `requestabilityOf` as one kind of caller is answered: what the digest allows the other
 * kind is a refusal to this one. The rule stays one function, so the two callers cannot
 * come to disagree about a digest — only about whose it is to ask for.
 */
export function requestabilityFor(
  kind: DigestRequestKind,
  standing: DigestStanding | null,
  transcribed: ReadonlySet<string>,
): DigestRequestability {
  const request = requestabilityOf(standing, transcribed);

  return request.allowed && request.kind !== kind
    ? refused(DigestRequestRefusal.OTHER_KIND)
    : request;
}
