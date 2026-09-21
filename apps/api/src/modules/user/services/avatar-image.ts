import { writeFile } from 'node:fs/promises';

import { Injectable, Logger } from '@nestjs/common';
import { AVATAR_SIZE_PIXELS, MAX_AVATAR_PIXELS } from '@repo/shared';
import sharp from 'sharp';

import { errorMessage } from '../../../common/error-message';

/** The formats `sharp` reports for the three types the contract allows. It names a format,
 *  not a media type, which is why this is a list of its spellings rather than of theirs. */
const ALLOWED_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp']);

/** Why a file was refused, for the caller to turn into a status and a message. The service
 *  does not throw HTTP exceptions: it reports, and the handler decides. */
export type AvatarRejection = 'type' | 'dimensions' | 'unreadable';

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
 * **The header is read before anything is decoded, and that is what bounds the work.** The
 * byte cap cannot: a flat-colour PNG of 20000 squared is sixty-nine bytes and would otherwise
 * be decoded in full on the request thread. The dimensions in the header are checked against
 * `MAX_AVATAR_PIXELS` first, so what is decoded is never larger than that.
 *
 * **Each step fails in exactly one way, which is why the decode and the write are separate
 * calls.** `sharp` reports a full disk and a truncated JPEG identically — a message, no errno
 * code — so a single `toFile` would have to guess which it was, and would tell a user their
 * picture was damaged when the volume filled up. Decoding produces a buffer (a few kilobytes,
 * at the size everything comes out), and writing it is `fs`, whose failures are the machine's
 * and are left to propagate as a 500.
 *
 * **Nothing is written outside `destinationPath`.** A file that cannot be decoded leaves the
 * caller free to abandon the request with the previous avatar still in place, which is the
 * PRD's rule and the reason this writes to a temp path rather than over the stored object.
 */
@Injectable()
export class AvatarImage {
  private readonly logger = new Logger(AvatarImage.name);

  async normalise(
    sourcePath: string,
    destinationPath: string,
  ): Promise<NormalisedAvatar | RejectedAvatar> {
    // One instance for the header read and the decode below, rather than opening the file
    // twice. `limitInputPixels` is off on purpose: the cap is applied here, from the header,
    // so an over-large picture is refused with a sentence that says so instead of `sharp`'s
    // own message arriving as "this image could not be read".
    const image = sharp(sourcePath, { limitInputPixels: false });
    const rejection = await this.inspect(image);

    if (rejection !== null) {
      return rejection;
    }

    let rendition: Buffer;

    try {
      rendition = await image
        // No argument applies the EXIF orientation, so a phone photo comes out the way up it
        // was taken. `cover` fills the square and crops the overflow, which is what keeps
        // every avatar the same shape whatever aspect ratio arrived; `withoutEnlargement` is
        // deliberately *not* set, because a small image must still come out the agreed size.
        .rotate()
        .resize(AVATAR_SIZE_PIXELS, AVATAR_SIZE_PIXELS, { fit: 'cover', position: 'centre' })
        .webp()
        .toBuffer();
    } catch (error) {
      // The header parsed and the pixels did not — a truncated or corrupted file.
      return this.refuse(error, 'decoding');
    }

    await writeFile(destinationPath, rendition);

    return { ok: true };
  }

  /**
   * What the header says, as a rejection or `null` for a file worth decoding. Reading it costs
   * no decode: the 20000-square PNG above answers in under a millisecond.
   */
  private async inspect(image: sharp.Sharp): Promise<RejectedAvatar | null> {
    let format: string | undefined;
    let width: number | undefined;
    let height: number | undefined;

    try {
      ({ format, width, height } = await image.metadata());
    } catch (error) {
      return this.refuse(error, 'reading the header');
    }

    if (format === undefined || width === undefined || height === undefined) {
      return { ok: false, reason: 'unreadable' };
    }

    if (!ALLOWED_FORMATS.has(format)) {
      // A real image of a type the contract does not take — a GIF, an SVG, a TIFF. A
      // different problem from a damaged file, and a different sentence.
      return { ok: false, reason: 'type' };
    }

    return width * height > MAX_AVATAR_PIXELS ? { ok: false, reason: 'dimensions' } : null;
  }

  /** A refusal, and the line that says why it happened. Without it a rejected upload leaves
   *  nothing at all behind: the user sees a sentence and the log sees nothing. */
  private refuse(error: unknown, step: string): RejectedAvatar {
    this.logger.debug(`Refused an avatar while ${step}: ${errorMessage(error)}`);

    return { ok: false, reason: 'unreadable' };
  }
}
