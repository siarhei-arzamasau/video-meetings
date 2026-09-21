import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { MulterError } from 'multer';

import { mapMulterError } from './multer-error';

/**
 * `@types/multer` 2.2.0 is the newest there is, and it predates the codes multer 2.4.0 raises —
 * which are exactly the ones this mapping exists for. The runtime class accepts any code.
 */
const UntypedMulterError = MulterError as unknown as new (
  code: string,
  field?: string,
) => MulterError;

describe('mapMulterError', () => {
  it('answers a file under an unexpected field name with 400, not the 500 it became', () => {
    // The case that breaks first: 2.4.0 renamed this message, so Nest 11 stops recognising it.
    const mapped = mapMulterError(new MulterError('LIMIT_UNEXPECTED_FILE', 'attachment'));

    expect(mapped).toBeInstanceOf(BadRequestException);
    expect((mapped as BadRequestException).message).toBe('Unexpected file field - attachment');
  });

  it.each([
    // Codes Nest 11 has no entry for at all.
    'INVALID_FIELD_NAME',
    'LIMIT_FIELD_NESTING',
    'LIMIT_FIELD_ARRAY_INDEX',
    'STREAM_DESTROYED',
    // The ones Nest 11 does know, which must keep answering what they did.
    'LIMIT_PART_COUNT',
    'LIMIT_FILE_COUNT',
    'LIMIT_FIELD_KEY',
    'LIMIT_FIELD_VALUE',
    'LIMIT_FIELD_COUNT',
    'MISSING_FIELD_NAME',
  ])('answers %s with 400', (code) => {
    expect(mapMulterError(new UntypedMulterError(code))).toBeInstanceOf(BadRequestException);
  });

  it('keeps the bare message when multer names no field', () => {
    const mapped = mapMulterError(new MulterError('LIMIT_FILE_COUNT'));

    expect((mapped as BadRequestException).message).toBe('Too many files');
  });

  it('answers the size limit with 413', () => {
    expect(mapMulterError(new MulterError('LIMIT_FILE_SIZE', 'file'))).toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('returns an HttpException Nest already mapped as it is', () => {
    const alreadyMapped = new PayloadTooLargeException('File too large');

    expect(mapMulterError(alreadyMapped)).toBe(alreadyMapped);
  });

  it('leaves anything else alone, so a full disk stays a 500', () => {
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    });

    expect(mapMulterError(diskFull)).toBe(diskFull);
    expect(mapMulterError(diskFull)).not.toBeInstanceOf(HttpException);
  });
});
