import type { Meeting, MeetingDigest, MeetingDigestAction, MeetingFile, User } from '@repo/shared';

import { digestPresentation } from './meeting-digest';
import type { DigestPresentation } from './meeting-digest';

/** The two names of the one request, as the PRD words them. */
export const GENERATE_DIGEST_LABEL = 'Generate digest';
export const RETRY_DIGEST_LABEL = 'Retry';
/** Said where a digest would be, in a section that is there only for its control. */
export const NO_DIGEST_YET_LABEL = "This meeting's recordings have no digest yet.";

const ACTION_LABELS: Record<MeetingDigestAction, string> = {
  generate: GENERATE_DIGEST_LABEL,
  retry: RETRY_DIGEST_LABEL,
};

/** Who is looking at the meeting, as far as the digest's control is concerned. */
export interface DigestActionViewer {
  userId: User['id'];
  hostId: Meeting['hostId'];
}

/**
 * What this reader is offered to ask for — "Generate digest", "Retry", or nothing.
 *
 * **Three things, and all three must hold.** The API says what the digest allows
 * (`availableAction`), and says the same to every reader of the meeting, because it rides an
 * event every open page is sent. Who may ask is the page's to work out, from the files it
 * already holds: the host, or the uploader of a recording that is transcribed — the people
 * the API would not answer 404. This function is the one place that is decided.
 *
 * **And nobody is offered anything while the list holds no transcribed recording, the host
 * included.** That is not a restatement of the API's rule but the repair of a gap in it:
 * when a meeting's last transcribed recording is deleted, `availableAction` leaves the
 * digest *without its version moving* — a meeting with nothing stored has no row to move
 * one on — so a page that keeps the higher of two versions goes on holding `generate`. The
 * deleted recording leaves the list by the same stream, and the list is what knows.
 *
 * A list that is still loading, or failed to load, is passed as no files: the control waits
 * for it rather than being drawn on a guess.
 */
export function offeredDigestAction(
  digest: MeetingDigest | null,
  files: ReadonlyArray<Pick<MeetingFile, 'uploaderId' | 'transcriptionStatus'>>,
  { userId, hostId }: DigestActionViewer,
): MeetingDigestAction | null {
  const action = digest?.availableAction;

  if (action === undefined) {
    return null;
  }

  const uploaderIds = files
    .filter(({ transcriptionStatus }) => transcriptionStatus === 'transcribed')
    .map(({ uploaderId }) => uploaderId);

  if (uploaderIds.length === 0) {
    return null;
  }

  return userId === hostId || uploaderIds.includes(userId) ? action : null;
}

/** The control, worded: which of the two it is decides its icon as well as its label. */
export interface DigestActionLine {
  kind: MeetingDigestAction;
  label: string;
}

export interface DigestSectionView extends DigestPresentation {
  /** What this reader may ask for. Absent for everyone the API would refuse. */
  action: DigestActionLine | null;
  /** Said in place of a digest when there is neither a status nor content to show. */
  notice: string | null;
}

/**
 * What the digest section draws for one reader, or `null` when it draws nothing at all.
 *
 * `digestPresentation` is what a digest says to anybody; this adds what one reader may do
 * about it. **So "no status and no content is no section" still holds for everyone who is
 * offered nothing** — and stops holding for the two states only a person can end: recordings
 * transcribed while the setting was off, and a digest withheld by a delete nothing reacted
 * to. There the section is drawn for its control alone, with a sentence where a digest would
 * be, because a button under a bare heading does not say what it is for.
 *
 * `offered` is `offeredDigestAction`'s answer, not the digest's own `availableAction`: what
 * the API would accept from somebody is not an offer to this reader.
 */
export function digestSectionView(
  digest: MeetingDigest | null,
  offered: MeetingDigestAction | null,
): DigestSectionView | null {
  const shown = digestPresentation(digest);

  if (shown === null && offered === null) {
    return null;
  }

  return {
    status: shown?.status ?? null,
    content: shown?.content ?? null,
    action: offered === null ? null : { kind: offered, label: ACTION_LABELS[offered] },
    notice: shown === null ? NO_DIGEST_YET_LABEL : null,
  };
}
