import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { MAX_MEETING_FILE_SIZE_BYTES } from '@repo/shared';
import { diskStorage } from 'multer';

import { MeetingFileStorage } from './meeting-file-storage';

/**
 * Multipart arrives on disk, not in memory: a 100 MB buffer per request is not acceptable.
 * The temp directory is under the storage root, so the later rename into place is atomic.
 *
 * No `fileFilter` for the type — the file has to be on disk to sniff it. `fileSize` is the
 * only limit multer enforces; it surfaces as a `PayloadTooLargeException`, which
 * `MeetingFileUploadInterceptor` maps to the PRD's copy.
 *
 * Two options are about the name reaching `normaliseFileName` as the client sent it:
 * `defParamCharset` because busboy decodes `filename` as latin1 by default, which turns
 * `отчёт.pdf` into mojibake; `preservePath` because without it multer takes the basename,
 * which would hide a path separator from the rule that exists to reject it.
 */
export function meetingFileMulterOptions(storage: MeetingFileStorage): MulterOptions {
  return {
    storage: diskStorage({ destination: storage.tempDir() }),
    limits: { fileSize: MAX_MEETING_FILE_SIZE_BYTES, files: 1, fields: 0 },
    preservePath: true,
    defParamCharset: 'utf8',
  };
}
