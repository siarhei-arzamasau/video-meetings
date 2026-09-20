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

  const first = firstCharacterOf(words[0]);
  const last = words.length > 1 ? firstCharacterOf(words[words.length - 1]) : '';

  return `${first}${last}`.toUpperCase();
}

/** `noUncheckedIndexedAccess` is on, so the caller's indexing is `string | undefined` here. */
function firstCharacterOf(word: string | undefined): string {
  return Array.from(word ?? '')[0] ?? '';
}
