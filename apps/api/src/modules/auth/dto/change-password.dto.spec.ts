import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@repo/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ChangePasswordDto } from './change-password.dto';

const CURRENT = 'correct-horse-battery-42';
const NEW = 'a-different-battery-43';

/** The global pipe's two steps on one body: transform, then validate. */
function validate(body: unknown): string[] {
  return validateSync(plainToInstance(ChangePasswordDto, body)).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
}

/**
 * The two fields are deliberately not validated alike, and that asymmetry is what this spec
 * pins down: the current password is checked the way `LoginDto` checks one — present, and
 * nothing more — while the new one is checked the way `RegisterDto` does, because it is the
 * value that becomes the account's password.
 */
describe('ChangePasswordDto', () => {
  it('accepts a current password and a new one that meet the registration bounds', () => {
    expect(validate({ currentPassword: CURRENT, newPassword: NEW })).toEqual([]);
  });

  it('applies no minimum to the current password', () => {
    // An account whose password predates today's minimum must still be able to change it.
    // Restating the policy here would lock its owner out of the very endpoint that fixes it.
    expect(validate({ currentPassword: 'old', newPassword: NEW })).toEqual([]);
  });

  it('still requires the current password to be there', () => {
    expect(validate({ currentPassword: '', newPassword: NEW })).not.toEqual([]);
    expect(validate({ newPassword: NEW })).not.toEqual([]);
  });

  it.each([
    ['one character under the minimum', 'x'.repeat(MIN_PASSWORD_LENGTH - 1)],
    ['one character over the maximum', 'x'.repeat(MAX_PASSWORD_LENGTH + 1)],
    ['nothing but spaces', ' '.repeat(MIN_PASSWORD_LENGTH + 2)],
  ])('refuses a new password that is %s', (_description, newPassword) => {
    expect(validate({ currentPassword: CURRENT, newPassword })).not.toEqual([]);
  });

  it.each([
    ['a numeric new password', { currentPassword: CURRENT, newPassword: 12_345_678 }],
    ['a null new password', { currentPassword: CURRENT, newPassword: null }],
    ['a numeric current password', { currentPassword: 12_345_678, newPassword: NEW }],
  ])('refuses %s rather than coercing it', (_description, body) => {
    // Implicit conversion is off globally for exactly this reason; the DTO must not be the
    // place that undoes it.
    expect(validate(body)).not.toEqual([]);
  });

  it('keeps the new password’s surrounding spaces, unlike a display name', () => {
    const padded = `  ${NEW}  `;

    const dto = plainToInstance(ChangePasswordDto, {
      currentPassword: CURRENT,
      newPassword: padded,
    });

    // A password is the bytes the user typed. Trimming one would silently store a credential
    // they did not choose, and then refuse the one they did.
    expect(dto.newPassword).toBe(padded);
  });
});
