import { MAX_EMAIL_LENGTH } from '@repo/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { normaliseEmail } from '../email';

export class LoginDto {
  @Transform(normaliseEmail)
  @IsString()
  @IsEmail()
  @MaxLength(MAX_EMAIL_LENGTH)
  email: string;

  /**
   * No minimum length here, deliberately. Login must accept whatever was once accepted at
   * registration, and restating the policy on this endpoint would only publish it.
   */
  @IsString()
  @IsNotEmpty()
  password: string;
}
