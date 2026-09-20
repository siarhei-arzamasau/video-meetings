import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  type UpdateDisplayNameRequest,
} from '@repo/shared';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateDisplayNameDto implements UpdateDisplayNameRequest {
  /**
   * Trimmed before the bounds are measured, so `"   "` is caught by the minimum rather than
   * needing a rule of its own, and a name padded past the maximum is accepted rather than
   * rejected for characters that were never going to be stored.
   *
   * Both bounds answer with the one shared message. The browser shows the same string from
   * the same constant, so a field that turns red says exactly what the server would.
   */
  @Transform(trimString)
  @IsString()
  @MinLength(MIN_DISPLAY_NAME_LENGTH, { message: DISPLAY_NAME_MESSAGE })
  @MaxLength(MAX_DISPLAY_NAME_LENGTH, { message: DISPLAY_NAME_MESSAGE })
  displayName: string;
}

/** Preserve non-strings so `@IsString()` can reject them instead of coercing input. */
function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
