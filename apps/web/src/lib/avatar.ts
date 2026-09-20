/**
 * The checks the avatar form runs before it uploads anything. Nothing here talks to the API —
 * this is what surrounds `uploadAvatar`.
 *
 * Every rule has a counterpart on the server and every message comes from `@repo/shared`, so
 * a file refused here reads exactly as it would have if it had been sent. The server keeps the
 * final say: it decodes the bytes, which is a thing no browser check can do for it, so a file
 * this accepts may still come back as a 415 or a 400.
 */

import {
  AVATAR_ALLOWED_TYPES,
  AVATAR_EMPTY_MESSAGE,
  AVATAR_SIZE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  MAX_AVATAR_SIZE_BYTES,
} from '@repo/shared';

/**
 * The message to show for a chosen file, or `null` when it may be uploaded.
 *
 * The order is the order the user can act on. Type first: a PDF is the wrong file whatever it
 * weighs, and telling its owner it is too large would send them to compress it. Emptiness
 * before size, because a zero-byte file is a different mistake from an oversized one and the
 * size rule would let it through.
 */
export function validateAvatarFile(file: File): string | null {
  // `file.type` is the browser's guess from the extension, so it is only ever a first pass —
  // the server decides by decoding. Being stricter here than the server is the failure that
  // matters, and this is not: every type the server takes is in the list.
  if (!AVATAR_ALLOWED_TYPES.includes(file.type)) {
    return AVATAR_TYPE_MESSAGE;
  }

  if (file.size === 0) {
    return AVATAR_EMPTY_MESSAGE;
  }

  if (file.size > MAX_AVATAR_SIZE_BYTES) {
    return AVATAR_SIZE_MESSAGE;
  }

  return null;
}
