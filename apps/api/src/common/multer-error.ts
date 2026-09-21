import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MulterError } from 'multer';

/**
 * A multer rejection as the 4xx it is, decided by `code` — never by message.
 *
 * Nest 11's `FileInterceptor` classifies multer's errors by comparing `error.message` with the
 * strings multer 2.2.0 used, and passes anything it does not recognise through as it is. multer
 * has not kept those strings: 2.4.0 renamed one of them — "Unexpected field" became "Unexpected
 * file field" — and releases since 2.2.0 raise codes Nest 11 has never heard of. On any of them,
 * each would reach `HttpExceptionFilter` as a raw error, and a file sent under the wrong field
 * name would answer 500. multer's own documentation says to check `code` rather than the
 * message, and this does.
 *
 * **Every multer error is the request's fault.** The size limit has a status of its own and the
 * rest are a 400, worded as Nest words them. Anything that is not a `MulterError` — an
 * `HttpException` Nest already mapped, or a disk error from the storage engine — comes back
 * untouched, so a full disk stays the 500 it is.
 */
export function mapMulterError(error: unknown): unknown {
  if (!(error instanceof MulterError)) {
    return error;
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeException(error.message);
  }

  return new BadRequestException(
    error.field === undefined ? error.message : `${error.message} - ${error.field}`,
  );
}
