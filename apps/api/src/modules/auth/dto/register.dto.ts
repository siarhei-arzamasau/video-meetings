import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { normaliseEmail } from '../email';

/** Longest address RFC 5321 permits. Bounds the column and the work done validating it. */
export const MAX_EMAIL_LENGTH = 254;

export const MIN_PASSWORD_LENGTH = 8;

/** A ceiling on hashing work, not a security rule — argon2 costs time per byte. */
export const MAX_PASSWORD_LENGTH = 256;

export class RegisterDto {
  @Transform(normaliseEmail)
  @IsString()
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  // Length alone would accept eight spaces as a password.
  @Matches(/\S/, { message: 'password must contain a non-whitespace character' })
  password: string;
}
