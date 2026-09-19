import { IsInt, IsString } from 'class-validator';

import { SIZE_POSITIVE_MESSAGE } from '../commands/handlers/create-upload.handler';

/**
 * Body of `POST /api/meetings/:id/files/uploads`.
 *
 * Deliberately thin. The name rule is `normaliseFileName`'s, in the handler, so both upload
 * paths reject a bad name with the same words; the size bounds are the handler's for the same
 * reason. What is left here is the type check — and it matters, because implicit conversion
 * is off globally, so `"size": "1024"` is a string and is rejected rather than coerced.
 *
 * `@IsInt` carries the handler's message so a non-integer reads the same whichever of the two
 * checks catches it.
 */
export class CreateUploadDto {
  @IsString()
  name: string;

  @IsInt({ message: SIZE_POSITIVE_MESSAGE })
  size: number;
}
