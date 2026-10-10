import type { Meeting, MeetingDigest, MeetingDigestAction, MeetingFile, User } from '@repo/shared';

import { digestPresentation } from './meeting-digest';
import type { DigestPresentation } from './meeting-digest';

/** The one request a reader makes of a digest: another try at one that failed. */
export const RETRY_DIGEST_LABEL = 'Retry';

/** A `Record`, so an action added to `@repo/shared` without its word here does not compile. */
const ACTION_LABELS: Record<MeetingDigestAction, string> = {
  retry: RETRY_DIGEST_LABEL,
};

/** Who is looking at the meeting, as far as the digest's control is concerned. */
export interface DigestActionViewer {
  userId: User['id'];
  hostId: Meeting['hostId'];
}

/**
 * What this reader is offered to ask for — "Retry", or nothing.
 *
 * **Three things, and all three must hold.** The API says what the digest allows
 * (`availableAction`), and says the same to every reader of the meeting, because it rides an
 * event every open page is sent. Who may ask is the page's to work out, from the files it
 * already holds: the host, or the uploader of a recording that is transcribed — the people
 * the API would not answer 404. This function is the one place that is decided.
 *
 * **And nobody is offered anything while the list holds no transcribed recording, the host
 * included.** That is not a restatement of the API's rule but the repair of a gap in it:
 * when the last transcribed recording of a meeting whose digest failed is deleted and
 * nothing reacts to the delete, `availableAction` leaves the digest *without its version
 * moving*, so a page that keeps the higher of two versions goes on holding `retry`. The
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

/** The control, worded. */
export interface DigestActionLine {
  label: string;
}

export interface DigestSectionView extends DigestPresentation {
  /** What this reader may ask for. Absent for everyone the API would refuse. */
  action: DigestActionLine | null;
}

/**
 * What the digest section draws for one reader, or `null` when it draws nothing at all.
 *
 * `digestPresentation` is what a digest says to anybody; this adds what one reader may do
 * about it. **"No status and no content is no section" holds for every reader**: a digest is
 * generated with nobody asking — when a recording is transcribed, or when the API next
 * starts — so a meeting that has none yet has nothing to offer either, and the one thing a
 * reader can ask for is beside a failure, which is itself something to show.
 *
 * `offered` is `offeredDigestAction`'s answer, not the digest's own `availableAction`: what
 * the API would accept from somebody is not an offer to this reader.
 */
export function digestSectionView(
  digest: MeetingDigest | null,
  offered: MeetingDigestAction | null,
): DigestSectionView | null {
  const shown = digestPresentation(digest);

  if (shown === null) {
    return null;
  }

  return {
    ...shown,
    action: offered === null ? null : { label: ACTION_LABELS[offered] },
  };
}
