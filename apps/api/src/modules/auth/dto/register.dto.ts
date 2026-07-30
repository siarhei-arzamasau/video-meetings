import { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@repo/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { normaliseEmail } from '../email';

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
