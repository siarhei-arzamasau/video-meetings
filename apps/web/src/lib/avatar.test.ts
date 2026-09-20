import {
  AVATAR_EMPTY_MESSAGE,
  AVATAR_SIZE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  MAX_AVATAR_SIZE_BYTES,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { validateAvatarFile } from './avatar';

/** A `File` of a given size and type without allocating the bytes: only `size` and `type` are
 *  read, and a 5 MB buffer per case would make this suite measurably slower for nothing. */
function fileOf(type: string, size: number, name = 'picture.png'): File {
  const file = new File([], name, { type });

  Object.defineProperty(file, 'size', { value: size });

  return file;
}

describe('validateAvatarFile', () => {
  it.each([['image/png'], ['image/jpeg'], ['image/webp']])('accepts %s', (type) => {
    expect(validateAvatarFile(fileOf(type, 1_024))).toBeNull();
  });

  it('accepts a file of exactly the cap', () => {
    expect(validateAvatarFile(fileOf('image/png', MAX_AVATAR_SIZE_BYTES))).toBeNull();
  });

  it('refuses a file one byte over the cap', () => {
    expect(validateAvatarFile(fileOf('image/png', MAX_AVATAR_SIZE_BYTES + 1))).toBe(
      AVATAR_SIZE_MESSAGE,
    );
  });

  it.each([
    ['a PDF', 'application/pdf'],
    ['a GIF', 'image/gif'],
    ['an SVG', 'image/svg+xml'],
    ['a type the browser could not guess', ''],
  ])('refuses %s', (_description, type) => {
    expect(validateAvatarFile(fileOf(type, 1_024))).toBe(AVATAR_TYPE_MESSAGE);
  });

  it('refuses an empty file with its own sentence', () => {
    // Not the size message: a zero-byte file passes the size rule, and "too large" would send
    // its owner to compress something that has nothing in it.
    expect(validateAvatarFile(fileOf('image/png', 0))).toBe(AVATAR_EMPTY_MESSAGE);
  });

  it('reports the wrong type before the wrong size', () => {
    // A PDF is the wrong file whatever it weighs, and telling its owner it is too large would
    // send them to compress it rather than to pick a picture.
    expect(validateAvatarFile(fileOf('application/pdf', MAX_AVATAR_SIZE_BYTES + 1))).toBe(
      AVATAR_TYPE_MESSAGE,
    );
  });

  it('judges the type rather than the name', () => {
    // The extension is not the check on either side: the browser reads `file.type` and the
    // server decodes the bytes.
    expect(validateAvatarFile(fileOf('application/pdf', 1_024, 'photo.png'))).toBe(
      AVATAR_TYPE_MESSAGE,
    );
    expect(validateAvatarFile(fileOf('image/png', 1_024, 'notes.pdf'))).toBeNull();
  });
});
