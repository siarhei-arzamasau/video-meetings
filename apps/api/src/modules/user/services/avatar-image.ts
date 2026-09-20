import { Injectable } from '@nestjs/common';
import { AVATAR_SIZE_PIXELS } from '@repo/shared';
import sharp from 'sharp';

/** The formats `sharp` reports for the three types the contract allows. It names a format,
 *  not a media type, which is why this is a list of its spellings rather than of theirs. */
const ALLOWED_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp']);

/** Why a file was refused, for the caller to turn into a status and a message. The service
 *  does not throw HTTP exceptions: it reports, and the handler decides. */
export type AvatarRejection = 'type' | 'unreadable';

export interface NormalisedAvatar {
  ok: true;
}

export interface RejectedAvatar {
  ok: false;
  reason: AvatarRejection;
}

/**
 * Turns whatever was uploaded into the one rendition the API serves: a square WebP,
 * `AVATAR_SIZE_PIXELS` on a side.
 *
 * **Decoding is the type check.** `sharp` reads the header and says what the file actually is,
 * so a PDF renamed `.png` is refused by the same step that would have resized it — there is no
 * separate sniff to disagree with. `ContentSniffer` in the meeting-files module is not reused
 * for the same reason `AvatarStorage` is not: its allow-list is that module's, and an avatar
 * has to be decodable rather than merely recognised.
 *
 * **Nothing is written outside `destinationPath`.** A file that cannot be decoded leaves the
 * caller free to abandon the request with the previous avatar still in place, which is the
 * PRD's rule and the reason this writes to a temp path rather than over the stored object.
 */
@Injectable()
export class AvatarImage {
  async normalise(
    sourcePath: string,
    destinationPath: string,
  ): Promise<NormalisedAvatar | RejectedAvatar> {
    const format = await this.formatOf(sourcePath);

    if (format === null) {
      return { ok: false, reason: 'unreadable' };
    }

    if (!ALLOWED_FORMATS.has(format)) {
      // A real image of a type the contract does not take — a GIF, an SVG, a TIFF. A
      // different problem from a damaged file, and a different sentence.
      return { ok: false, reason: 'type' };
    }

    try {
      await sharp(sourcePath)
        // No argument applies the EXIF orientation, so a phone photo comes out the way up it
        // was taken. `cover` fills the square and crops the overflow, which is what keeps
        // every avatar the same shape whatever aspect ratio arrived; `withoutEnlargement` is
        // deliberately *not* set, because a small image must still come out the agreed size.
        .rotate()
        .resize(AVATAR_SIZE_PIXELS, AVATAR_SIZE_PIXELS, { fit: 'cover', position: 'centre' })
        .webp()
        .toFile(destinationPath);
    } catch {
      // The header parsed but the pixels did not — a truncated or corrupted file.
      return { ok: false, reason: 'unreadable' };
    }

    return { ok: true };
  }

  /** The format `sharp` reads from the header, or `null` for anything it cannot open at all. */
  private async formatOf(sourcePath: string): Promise<string | null> {
    try {
      const { format } = await sharp(sourcePath).metadata();

      return format ?? null;
    } catch {
      return null;
    }
  }
}
