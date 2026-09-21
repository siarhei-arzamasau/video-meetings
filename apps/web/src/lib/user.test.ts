import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { initialsOf, validateDisplayName } from './user';

describe('initialsOf', () => {
  it('takes the first letter of the first and last word', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
  });

  it('skips the middle of a longer name', () => {
    expect(initialsOf('Ada Byron King Lovelace')).toBe('AL');
  });

  it('gives one letter for a single word, which is what a derived name is', () => {
    // Registration derives the name from the email local part, so most accounts arrive here
    // with exactly one word and no space to split on.
    expect(initialsOf('ada')).toBe('A');
  });

  it('uppercases whatever it took', () => {
    expect(initialsOf('ada lovelace')).toBe('AL');
  });

  it('ignores the whitespace around and between the words', () => {
    expect(initialsOf('  Ada   Lovelace  ')).toBe('AL');
  });

  it('counts a character, not a code unit', () => {
    // 'A' outside the BMP is two code units; `name[0]` would take half of one and render a
    // replacement character.
    expect(initialsOf('𝐀da 𝐋ovelace')).toBe('𝐀𝐋');
  });

  it('stays at two characters when uppercasing lengthens one', () => {
    // `'ß'.toUpperCase()` is 'SS' and `'ﬁ'.toUpperCase()` is 'FI'. Uppercasing the joined pair
    // would put four glyphs into a circle sized for two.
    expect(initialsOf('ßeta ßoy')).toBe('SS');
    expect(initialsOf('ﬁrst')).toBe('F');
  });

  it('falls back to a question mark when there is nothing to take', () => {
    // The API will not store a blank name, so this is a defence rather than a case — but it
    // renders inside a circle that has to hold something.
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});

describe('validateDisplayName', () => {
  it('accepts a name the API would store', () => {
    expect(validateDisplayName('Ada Lovelace')).toBeNull();
  });

  it('accepts the shortest name the bounds allow', () => {
    expect(validateDisplayName('a'.repeat(MIN_DISPLAY_NAME_LENGTH))).toBeNull();
  });

  it('measures the trimmed value, as the API does', () => {
    // `UpdateDisplayNameDto` trims before it measures, so a name padded past the maximum is
    // accepted there. Refusing it here would be stricter than the server with no appeal.
    const longest = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);

    expect(validateDisplayName(`    ${longest}    `)).toBeNull();
    expect(validateDisplayName('  Ada  ')).toBeNull();
  });

  it('counts an emoji as one character, as the API does', () => {
    // Two UTF-16 code units each, so counting `.length` would refuse this at 41 of them —
    // stricter than the server, with no appeal.
    expect(validateDisplayName('\u{1F600}'.repeat(MAX_DISPLAY_NAME_LENGTH))).toBeNull();
  });

  it.each([
    ['blank', ''],
    ['whitespace-only', '   '],
    ['over the maximum once trimmed', `  ${'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)}  `],
    ['one emoji over the maximum', '\u{1F600}'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)],
  ])('refuses a %s name with the shared message', (_case, name) => {
    // The same constant the API's DTO carries, so a field that turns red says what the
    // server would have said.
    expect(validateDisplayName(name)).toBe(DISPLAY_NAME_MESSAGE);
  });
});
