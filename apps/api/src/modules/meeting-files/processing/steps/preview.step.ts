import sharp from 'sharp';

import { thumbnailKeyOf } from '../../services/meeting-file.mapper';
import { StepError } from '../step';
import type { ProcessingStep, StepContext, StepPatch } from '../step';

export const UNREADABLE_IMAGE_MESSAGE = 'The image could not be read';

/** Longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 320;

/**
 * A bounded WebP thumbnail beside the original, for images only; a no-op for every other
 * type. `rotate()` with no argument applies the EXIF orientation, so a phone photo comes out
 * the way up it was taken. GIFs use their first frame, which is sharp's default.
 */
export class PreviewStep implements ProcessingStep {
  readonly name = 'preview';

  async run({ record, storage }: StepContext): Promise<StepPatch> {
    if (!record.contentType.startsWith('image/')) {
      return {};
    }

    const thumbnailKey = thumbnailKeyOf(record.storageKey);

    try {
      await sharp(storage.pathOf(record.storageKey))
        .rotate()
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toFile(storage.pathOf(thumbnailKey));
    } catch (error) {
      throw new StepError(UNREADABLE_IMAGE_MESSAGE, { cause: error });
    }

    return { thumbnailKey };
  }
}
