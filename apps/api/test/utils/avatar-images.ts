import zlib from 'node:zlib';

import sharp from 'sharp';

/** One PNG chunk: length, type, payload, CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));

  return Buffer.concat([length, body, crc]);
}

/**
 * The images the avatar e2e spec uploads, built in memory rather than committed as fixtures.
 *
 * Two reasons. The spec's central claim is that *any* shape comes out as one square, and a
 * generated image lets a test name the shape it is testing instead of describing a file
 * somebody has to open to understand. And the over-size case needs more than five megabytes,
 * which is not a thing to keep in a repository.
 *
 * `sharp` is already an API dependency — it is what normalises the upload — so this adds
 * nothing to the tree.
 */
export function imageOf(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp' | 'gif',
  /**
   * The solid colour to fill it with. It has a parameter because the rendition is what the
   * spec compares: two different shapes of the same flat colour normalise to byte-identical
   * squares, so "this picture replaced that one" can only be asserted by making them differ
   * in something the crop keeps.
   */
  colour: { r: number; g: number; b: number } = { r: 20, g: 120, b: 200 },
): Promise<Buffer> {
  const canvas = sharp({
    create: { width, height, channels: 3, background: colour },
  });

  switch (format) {
    case 'png':
      return canvas.png().toBuffer();
    case 'jpeg':
      return canvas.jpeg().toBuffer();
    case 'webp':
      return canvas.webp().toBuffer();
    case 'gif':
      return canvas.gif().toBuffer();
  }
}

/** The dimensions and format of a stored rendition, read back from what the API served. */
export async function describeImage(
  bytes: Buffer,
): Promise<{ width?: number; height?: number; format?: string }> {
  const { width, height, format } = await sharp(bytes).metadata();

  return { width, height, format };
}

/**
 * A PNG the API will accept on size and cannot decode: header and trailer intact so it is
 * recognisably a PNG, everything between zeroed so `sharp` fails on the pixels.
 *
 * The distinction matters to the spec — a file rejected for its *type* and one rejected as
 * unreadable carry different sentences, and only a file like this exercises the second.
 */
export async function undecodablePng(): Promise<Buffer> {
  const whole = await imageOf(64, 64, 'png');
  const broken = Buffer.from(whole);
  broken.fill(0, 40, broken.length - 12);

  return broken;
}

/**
 * A buffer one byte over the cap, under a PNG header so the rejection is about the size and
 * not the type. Never decoded — multer refuses it before anything looks at the bytes.
 */
export async function oversizedImage(capBytes: number): Promise<Buffer> {
  const header = await imageOf(8, 8, 'png');

  return Buffer.concat([header, Buffer.alloc(capBytes + 1 - header.length)]);
}

/**
 * A PNG that claims an enormous size in its header and carries almost nothing behind it.
 *
 * The one file the byte cap cannot catch: 400 megapixels in under a hundred bytes, which the
 * API would otherwise decode in full on the request thread. It is assembled by hand because
 * `sharp` cannot produce one — asking it for a 20000-square image would allocate the gigabyte
 * this file exists to prove nobody has to.
 */
export function pixelBombPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
