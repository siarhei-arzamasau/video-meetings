import { describe, expect, it } from 'vitest';

import { initialsOf } from './user';

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

  it('falls back to a question mark when there is nothing to take', () => {
    // The API will not store a blank name, so this is a defence rather than a case — but it
    // renders inside a circle that has to hold something.
    expect(initialsOf('   ')).toBe('?');
    expect(initialsOf('')).toBe('?');
  });
});
