import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

import {
  normaliseEmail,
  validateEmail,
  validateLoginPassword,
  validateNewPassword,
  validatePassword,
  validatePasswordConfirmation,
} from './credentials';

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

describe('validateLoginPassword', () => {
  it('accepts a password shorter than registration allows, as the login endpoint does', () => {
    // The case this function exists for. `validatePassword` rejects it, and using that on the
    // sign-in form would lock out an account whose password predates the current minimum.
    expect(validateLoginPassword('a'.repeat(MIN_PASSWORD_LENGTH - 3))).toBeNull();
  });

  it('accepts a single character', () => {
    expect(validateLoginPassword('a')).toBeNull();
  });

  it('accepts a run of spaces, which the login endpoint does not refuse either', () => {
    expect(validateLoginPassword('  ')).toBeNull();
  });

  it('rejects an empty value, matching the API @IsNotEmpty()', () => {
    expect(validateLoginPassword('')).not.toBeNull();
  });

  it('accepts a password at the maximum length', () => {
    expect(validateLoginPassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects one character past the maximum', () => {
    expect(validateLoginPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).not.toBeNull();
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases, matching the API', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});

describe('validateNewPassword', () => {
  const CURRENT = 'old-password';

  it('accepts a password that meets the registration bounds and differs from the current', () => {
    expect(validateNewPassword('a-new-password', CURRENT)).toBeNull();
  });

  it('applies the registration rules, not the sign-in ones', () => {
    // This value becomes the account's password, so today's minimum is exactly what it must
    // meet — unlike the current-password field beside it.
    expect(validateNewPassword('short', CURRENT)).toBe(validatePassword('short'));
    expect(validateNewPassword(' '.repeat(MIN_PASSWORD_LENGTH + 2), CURRENT)).toBe(
      validatePassword(' '.repeat(MIN_PASSWORD_LENGTH + 2)),
    );
    expect(validateNewPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), CURRENT)).toBe(
      validatePassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)),
    );
  });

  it('refuses a new password identical to the current one', () => {
    expect(validateNewPassword(CURRENT, CURRENT)).toBe(PASSWORD_UNCHANGED_MESSAGE);
  });

  it('compares the two verbatim rather than trimming either', () => {
    // The API compares the bytes it was sent, so a client that trimmed would call two
    // different passwords the same and refuse a change the server would have accepted.
    expect(validateNewPassword(` ${CURRENT} `, CURRENT)).toBeNull();
  });

  it('says nothing about being unchanged while the current-password field is empty', () => {
    // An empty current password is that field's problem. Pointing the reader at the new one
    // would send them to fix the input that is not wrong.
    expect(validateNewPassword('a-new-password', '')).toBeNull();
    expect(validateNewPassword('', '')).toBe(validatePassword(''));
  });

  it('reports the bounds before it reports sameness', () => {
    // A value that is both too short and identical to the current one has a single actionable
    // problem, and it is the length.
    expect(validateNewPassword('short', 'short')).toBe(validatePassword('short'));
  });
});

describe('validatePasswordConfirmation', () => {
  it('accepts a confirmation that matches', () => {
    expect(validatePasswordConfirmation('a-new-password', 'a-new-password')).toBeNull();
  });

  it('refuses a mismatch with the shared sentence', () => {
    expect(validatePasswordConfirmation('a-new-passwerd', 'a-new-password')).toBe(
      PASSWORD_MISMATCH_MESSAGE,
    );
  });

  it('asks for the field to be filled rather than calling an empty one a mismatch', () => {
    expect(validatePasswordConfirmation('', 'a-new-password')).toBe('Repeat your new password.');
  });

  it('compares verbatim, so a stray space is a mismatch', () => {
    // It is: the confirmation exists to catch a typo, and a trailing space in the new password
    // is a typo the user needs to see now rather than at their next sign-in.
    expect(validatePasswordConfirmation('a-new-password ', 'a-new-password')).toBe(
      PASSWORD_MISMATCH_MESSAGE,
    );
  });
});
