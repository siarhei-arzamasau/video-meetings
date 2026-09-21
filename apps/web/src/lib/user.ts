/**
 * The display name, as the app renders it and as the app checks it. Nothing here talks to the
 * API — the name arrives with `getMe` and leaves through `updateDisplayName`; this is what
 * surrounds those two calls.
 */

import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
} from '@repo/shared';

/** What a name with nothing renderable in it falls back to, so the circle is never empty. */
const NO_INITIALS = '?';

/**
 * Up to two letters standing in for the person: the first and the last word's, uppercased.
 *
 * It stands in wherever there is no picture, so it has to cope with the name registration
 * derives as readily as with one the user chose — the derived
 * name is the email's local part, which is one word.
 *
 * Characters are taken with `Array.from`, not `name[0]`: a letter outside the BMP is two code
 * units, and indexing one would render half a surrogate pair.
 */
export function initialsOf(displayName: string): string {
  const words = displayName.split(/\s+/).filter((word) => word !== '');

  if (words.length === 0) {
    return NO_INITIALS;
  }

  const first = initialOf(words[0]);
  const last = words.length > 1 ? initialOf(words[words.length - 1]) : '';

  return `${first}${last}`;
}

/**
 * One uppercase character for a word, or nothing for no word.
 *
 * The uppercasing happens **here**, per character, rather than once over the joined pair,
 * because it can lengthen: `'ß'.toUpperCase()` is `'SS'` and `'ﬁ'.toUpperCase()` is `'FI'`.
 * Uppercasing the pair would put three or four glyphs into a circle sized for two.
 *
 * `noUncheckedIndexedAccess` is on, so the caller's indexing is `string | undefined` here.
 */
function initialOf(word: string | undefined): string {
  const first = Array.from(word ?? '')[0];

  return first === undefined ? '' : (Array.from(first.toUpperCase())[0] ?? '');
}

/**
 * The message to show for a display name, or `null` when it passes.
 *
 * The bounds and the sentence both come from `@repo/shared`, so this is `UpdateDisplayNameDto`
 * restated rather than a second rule: same trim, same bounds, same one message for blank,
 * whitespace-only, and over-long alike — a distinction the user could not act on differently.
 * The API keeps the final say and `updateDisplayName` surfaces whatever it says; this only
 * saves a round trip, which is why it must never be the stricter of the two.
 *
 * Length in UTF-16 code units, matching `@Length` on the DTO. Counting characters here would
 * accept a name of emoji the server then refuses, which is the one direction that costs the
 * user an unappealable rejection.
 */
export function validateDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();

  if (trimmed.length < MIN_DISPLAY_NAME_LENGTH || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return DISPLAY_NAME_MESSAGE;
  }

  return null;
}
