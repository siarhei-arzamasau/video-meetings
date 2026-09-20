/**
 * Presentation derived from the user record. Nothing here talks to the API — the display name
 * arrives with `getMe`, and these are the ways the app renders it.
 */

/** What a name with nothing renderable in it falls back to, so the circle is never empty. */
const NO_INITIALS = '?';

/**
 * Up to two letters standing in for the person: the first and the last word's, uppercased.
 *
 * This is the avatar until phase 6 uploads one, and the fallback afterwards, so it has to
 * cope with the name registration derives as readily as with one the user chose — the derived
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
