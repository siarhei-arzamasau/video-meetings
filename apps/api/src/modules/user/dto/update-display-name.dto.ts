import {
  DISPLAY_NAME_MESSAGE,
  isDisplayNameWithinBounds,
  type UpdateDisplayNameRequest,
} from '@repo/shared';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, ValidateBy } from 'class-validator';

export class UpdateDisplayNameDto implements UpdateDisplayNameRequest {
  /**
   * Trimmed before the bounds are measured, so `"   "` is caught by the minimum rather than
   * needing a rule of its own, and a name padded past the maximum is accepted rather than
   * rejected for characters that were never going to be stored.
   *
   * The bounds are the `@repo/shared` predicate the handler and the browser also call, not
   * `@Length`: validator.js counts its own way (surrogate pairs as one, variation selectors as
   * none), and a second counting rule is how an 80-emoji name once passed here and was refused
   * by the handler. One decorator covers both bounds, so a value that is not a string at all is
   * reported once rather than once per bound. The browser shows that string from the same
   * constant, so a field that turns red says what the server would.
   */
  @Transform(trimString)
  @IsString()
  @IsDisplayNameWithinBounds()
  displayName: string;
}

/** Preserve non-strings so `@IsString()` can reject them instead of coercing input. */
function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function IsDisplayNameWithinBounds(): PropertyDecorator {
  return ValidateBy({
    name: 'isDisplayNameWithinBounds',
    validator: {
      validate: (value: unknown): boolean =>
        typeof value === 'string' && isDisplayNameWithinBounds(value),
      defaultMessage: (): string => DISPLAY_NAME_MESSAGE,
    },
  });
}
