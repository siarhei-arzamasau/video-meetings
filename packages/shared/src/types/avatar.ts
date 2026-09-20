/*
 * The avatar contract: what the API accepts, what it serves, and the sentence a rejection
 * carries. Shared for the reason every bound in this package is — the browser rejects what
 * the API would reject anyway, and a second copy would drift into a 400 the form said could
 * not happen.
 *
 * Its own file rather than a section of `./user`, because an avatar brings a type list, a
 * cap, a rendition size, and four messages with it, and `user.ts` is about the record.
 */

/**
 * The three types the API decodes. Deliberately short: an avatar is rendered inline in a
 * header, and every entry here is a format `sharp` reads and the browser draws.
 *
 * GIF and SVG are absent on purpose. A GIF avatar is an animation in the corner of every
 * page, and an SVG is a document — one served inline is a stored XSS, which is why the
 * meeting-file list excludes it too. The upload is normalised to WebP whatever arrives, so
 * this list bounds what the server is willing to *decode*, not what it serves.
 */
export const AVATAR_ALLOWED_TYPES: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** Extensions for the file picker's `accept` attribute; browsers honour these where they
 *  filter media types inconsistently. The server still decides by decoding the bytes. */
export const AVATAR_ACCEPT: ReadonlyArray<string> = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * 5 MB — a twentieth of the meeting-file cap, and deliberately not derived from it. They
 * bound different things: a meeting file is whatever the user needs to share, an avatar is
 * one small square the server is about to re-encode. A phone photo clears this comfortably.
 */
export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * The side of the square every avatar is stored and served at, in pixels. Large enough for
 * the profile page's circle on a high-density screen, small enough that the header's copy of
 * it is not a wasted download.
 */
export const AVATAR_SIZE_PIXELS = 256;

/** What the API serves, whatever was uploaded. Stated here so the client knows it will never
 *  be handed a GIF it has to decide about. */
export const AVATAR_CONTENT_TYPE = 'image/webp';

/*
 * One sentence per rule, and each is shown by whichever side caught the problem — the browser
 * checks size, type, and emptiness before uploading, and the API checks all three again
 * because a command has to be safe whatever sent it.
 */

export const AVATAR_SIZE_MESSAGE = 'Your picture must be 5 MB or smaller.';
export const AVATAR_TYPE_MESSAGE = 'Your picture must be a PNG, JPEG, or WebP image.';
export const AVATAR_EMPTY_MESSAGE = 'The file is empty.';

/**
 * A file whose type is right and whose bytes are not. Distinct from `AVATAR_TYPE_MESSAGE`
 * because the two are different problems to the person holding the file: one means "pick a
 * different kind of file", the other means "this one is damaged".
 */
export const AVATAR_UNREADABLE_MESSAGE = 'That image could not be read. Try a different file.';
