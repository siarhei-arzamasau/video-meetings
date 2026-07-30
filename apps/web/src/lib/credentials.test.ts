import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { normaliseEmail, validateEmail, validatePassword } from './credentials';

describe('validateEmail', () => {
  it('accepts an ordinary address', () => {
    expect(validateEmail('ada@example.com')).toBeNull();
  });

  it('accepts an address that only surrounding whitespace made invalid', () => {
    expect(validateEmail('  ada@example.com  ')).toBeNull();
  });

  it('accepts a plus-addressed mailbox', () => {
    expect(validateEmail('ada+meetings@example.co.uk')).toBeNull();
  });

  it.each([
    ['an empty value', ''],
    ['whitespace only', '   '],
    ['no domain', 'ada@'],
    ['no mailbox', '@example.com'],
    ['no at sign', 'ada.example.com'],
    ['no dot in the domain', 'ada@example'],
    ['an inner space', 'ada @example.com'],
  ])('rejects %s', (_case, value) => {
    expect(validateEmail(value)).not.toBeNull();
  });

  it('rejects an address longer than the API accepts', () => {
    const tooLong = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`;

    expect(validateEmail(tooLong)).not.toBeNull();
  });

  it('measures length after trimming, as the API does', () => {
    const atTheLimit = `${'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length)}@example.com`;

    expect(validateEmail(`  ${atTheLimit} `)).toBeNull();
  });
});

describe('validatePassword', () => {
  it('accepts a password at the minimum length', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('accepts a password at the maximum length', () => {
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects one character short of the minimum', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
  });

  it('rejects one character past the maximum', () => {
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).not.toBeNull();
  });

  it('rejects a long enough run of spaces, which length alone would accept', () => {
    expect(validatePassword(' '.repeat(MIN_PASSWORD_LENGTH))).not.toBeNull();
  });

  it('keeps a password that merely contains spaces', () => {
    expect(validatePassword('correct horse battery')).toBeNull();
  });

  it('does not trim, since the API hashes what it is sent', () => {
    expect(validatePassword(`  ${'a'.repeat(MIN_PASSWORD_LENGTH)}  `)).toBeNull();
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases, matching the API', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});
