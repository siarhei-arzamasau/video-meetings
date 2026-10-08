import type { UserDisplayName } from '../../user/queries/find-users-by-ids.query';
import type { MeetingDigestAnswer } from './meeting-digest-answer';

/**
 * Which member of the meeting each owner an answer names is: the name as spoken, to that
 * member's user id. A name that is not a key identified nobody, or more than one person,
 * and stays a name.
 *
 * Keyed by the spoken name because the match is a function of nothing else — two action
 * items that name "Grace" are owned by the same member or by neither.
 */
export type DigestOwnerLinks = ReadonlyMap<string, string>;

/** No name linked to anybody: an answer that names nobody, or a meeting whose members are unknown. */
export const NO_OWNER_LINKS: DigestOwnerLinks = new Map<string, string>();

/** Whatever separates one word of a name from the next: anything but a letter, a mark, or a digit. */
const BETWEEN_WORDS = /[^\p{L}\p{M}\p{N}]+/u;

/**
 * The words of a name, as they are compared: without case, and with a letter and its accent
 * in one composed form, so the same name typed two ways is the same words. Nothing is folded
 * beyond that — an accent dropped or a name written in another script is a different word,
 * because a doubtful match is not a match.
 *
 * Splitting on everything that is not part of a word is what lets a name derived from an
 * email address take part: `ada.lovelace` is the words "ada" and "lovelace".
 */
function wordsOf(name: string): string[] {
  return name
    .normalize('NFC')
    .toLowerCase()
    .split(BETWEEN_WORDS)
    .filter((word) => word !== '');
}

/**
 * The member a spoken name identifies, as their user id — or `null`, which is the answer
 * whenever there is any doubt.
 *
 * **The rule is the plan's decision 5: every word of the spoken name is a word of exactly
 * one member's display name, compared without case.** So "Grace" links to Grace Hopper
 * when she is the only Grace in the meeting, and to nobody when there are two; "Dr Hopper"
 * links to nobody, because "dr" is a word of no name here; and a name with no word in it
 * links to nobody.
 *
 * A wrong owner is worse than no owner — Whisper writes a name as it hears it — so nothing
 * here is approximate: no prefixes, no initials, no nearest spelling. `members` is the
 * meeting's host and participants and nobody else, which is what keeps an answer, however
 * it was arrived at, from pointing at a user outside the meeting.
 */
export function matchOwner(
  spokenName: string,
  members: ReadonlyArray<UserDisplayName>,
): string | null {
  const spokenWords = wordsOf(spokenName);

  if (spokenWords.length === 0) {
    return null;
  }

  const identified = new Set(
    members
      .filter(({ displayName }) => {
        const nameWords = new Set(wordsOf(displayName));

        return spokenWords.every((word) => nameWords.has(word));
      })
      .map(({ id }) => id),
  );
  const [memberId] = identified;

  return identified.size === 1 && memberId !== undefined ? memberId : null;
}

/** Every owner an answer names, matched against the meeting's members — `matchOwner`, per name. */
export function linkOwners(
  answer: MeetingDigestAnswer,
  members: ReadonlyArray<UserDisplayName>,
): DigestOwnerLinks {
  const links = new Map<string, string>();

  for (const { ownerName } of answer.actionItems) {
    const memberId = ownerName === undefined ? null : matchOwner(ownerName, members);

    if (ownerName !== undefined && memberId !== null) {
      links.set(ownerName, memberId);
    }
  }

  return links;
}
