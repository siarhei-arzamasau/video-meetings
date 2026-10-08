import type { MeetingDigest } from '@repo/shared';

/** As much of a digest as an announcement about it needs. */
type Followed = Pick<MeetingDigest, 'status' | 'content'>;

export const DIGEST_READY_PHRASE = 'The meeting digest is ready.';
export const DIGEST_UPDATED_PHRASE = 'The meeting digest was updated.';
export const DIGEST_FAILED_PHRASE = 'Generating the meeting digest failed.';
export const DIGEST_REMOVED_PHRASE = 'The meeting digest was removed.';

/**
 * What a screen reader is told when the digest on an open page changes, or `null` when
 * nothing worth interrupting for did.
 *
 * The page follows its digest over a stream, so a digest arrives, is replaced, or goes with
 * no action from the reader — changes only a sighted one would otherwise notice.
 *
 * **Only the ends are announced, as a transcription's are**: a digest that arrived or was
 * replaced, a generation that failed, and a digest that was taken away. Queued and
 * Generating… are steps on the way, and so is the out-of-date mark, which says a replacement
 * is coming and is followed by the phrase that says it came.
 *
 * **Never the opening state**: `previous` is `null` until the page has heard from the API
 * once, and what it hears first is what the meeting already was.
 *
 * A digest is told apart from the one before it by when it was generated — the one thing
 * about stored content that a new generation always changes.
 */
export function digestAnnouncement(
  previous: Followed | null,
  current: Followed | null,
): string | null {
  if (previous === null || current === null) {
    return null;
  }

  if (current.status === 'failed' && previous.status !== 'failed') {
    return DIGEST_FAILED_PHRASE;
  }

  const before = previous.content?.generatedAt;
  const now = current.content?.generatedAt;

  if (now === undefined) {
    return before === undefined ? null : DIGEST_REMOVED_PHRASE;
  }

  if (now === before) {
    return null;
  }

  return before === undefined ? DIGEST_READY_PHRASE : DIGEST_UPDATED_PHRASE;
}
