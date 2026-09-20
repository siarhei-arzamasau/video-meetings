import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type ChangePasswordRequest } from '@repo/shared';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto implements ChangePasswordRequest {
  /**
   * `LoginDto`'s rules, and for `LoginDto`'s reason: this field is checked against what was
   * once accepted, so restating today's minimum on it would refuse an old password the API
   * itself stored — and publish the policy to an endpoint that has no need to state it.
   */
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  /** `RegisterDto`'s rules, because this is the value that becomes the account's password.
   *  Length alone would accept eight spaces. */
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  @Matches(/\S/, { message: 'newPassword must contain a non-whitespace character' })
  newPassword: string;
}
