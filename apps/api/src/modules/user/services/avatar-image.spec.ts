import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { AVATAR_SIZE_PIXELS, MAX_AVATAR_PIXELS } from '@repo/shared';
import sharp from 'sharp';

import { AvatarImage } from './avatar-image';

/**
 * Real `sharp` on real files, not a mock. The whole value of this service is what comes out
 * the other end — one square, always the same size, whatever went in — and a mocked `sharp`
 * would assert the arguments this file passes rather than the property the PRD asks for.
 */
/** One PNG chunk: length, type, payload, CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));

  return Buffer.concat([length, body, crc]);
}

describe('AvatarImage', () => {
  const images = new AvatarImage();
  let directory: string;

  const sourceOf = (name: string): string => path.join(directory, name);

  /** A solid image of the given shape, in the given format. */
  const write = async (
    name: string,
    width: number,
    height: number,
    format: 'png' | 'jpeg' | 'webp' | 'gif',
  ): Promise<string> => {
    const file = sourceOf(name);
    const canvas = sharp({
      create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
    });

    await (format === 'gif'
      ? canvas.gif().toFile(file)
      : format === 'png'
        ? canvas.png().toFile(file)
        : format === 'jpeg'
          ? canvas.jpeg().toFile(file)
          : canvas.webp().toFile(file));

    return file;
  };

  /**
   * A PNG that claims a given size in its header and carries almost no data — the shape of the
   * file the pixel cap exists for. Written by hand because `sharp` cannot produce one: asking
   * it for a 20000-square image would allocate the gigabyte this test is about avoiding.
   */
  const writeHeaderOnlyPng = (name: string, width: number, height: number): string => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolour

    const file = sourceOf(name);
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(64))),
        pngChunk('IEND', Buffer.alloc(0)),
      ]),
    );

    return file;
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-image-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  describe('what it produces', () => {
    it.each([
      ['a wide image', 800, 200],
      ['a tall image', 200, 800],
      ['an already square image', 512, 512],
      ['an image smaller than the rendition', 64, 40],
      ['a one-pixel image', 1, 1],
    ])('turns %s into the one agreed square', async (_description, width, height) => {
      const source = await write('in.png', width, height, 'png');
      const destination = sourceOf('out.webp');

      await expect(images.normalise(source, destination)).resolves.toEqual({ ok: true });

      const { width: outWidth, height: outHeight, format } = await sharp(destination).metadata();

      expect(outWidth).toBe(AVATAR_SIZE_PIXELS);
      expect(outHeight).toBe(AVATAR_SIZE_PIXELS);
      // WebP whatever arrived, so the fetch endpoint can name one type and mean it.
      expect(format).toBe('webp');
    });

    it.each([['png'], ['jpeg'], ['webp']] as const)('accepts %s', async (format) => {
      const source = await write(`in.${format}`, 300, 200, format);

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({ ok: true });
    });

    it('leaves the source file alone', async () => {
      const source = await write('in.png', 300, 200, 'png');
      const before = fs.readFileSync(source);

      await images.normalise(source, sourceOf('out.webp'));

      expect(fs.readFileSync(source).equals(before)).toBe(true);
    });
  });

  describe('what it refuses', () => {
    it('refuses a real image of a type the contract does not take', async () => {
      // A GIF decodes perfectly well. It is refused because an animation in the corner of
      // every page is not what an avatar is for — a different problem from a broken file, and
      // the reason the two reasons are distinct.
      const source = await write('in.gif', 200, 200, 'gif');

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'type',
      });
    });

    it('refuses an SVG, which decodes but is a document', async () => {
      const source = sourceOf('in.svg');
      fs.writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'type',
      });
    });

    it('refuses a file that is not an image at all', async () => {
      const source = sourceOf('in.png');
      // A PNG extension over text: decoding is the check, so the name never gets a vote.
      fs.writeFileSync(source, 'this is not a picture');

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('refuses a truncated image whose header still parses', async () => {
      const source = await write('in.png', 400, 400, 'png');
      const whole = fs.readFileSync(source);
      fs.writeFileSync(source, whole.subarray(0, Math.floor(whole.length / 3)));

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('refuses an empty file', async () => {
      const source = sourceOf('in.png');
      fs.writeFileSync(source, '');

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'unreadable',
      });
    });

    it('writes no rendition for anything it refuses', async () => {
      // The handler leaves the previous avatar in place on a rejection, and it can only do
      // that because nothing was produced to move.
      const source = sourceOf('in.png');
      fs.writeFileSync(source, 'not a picture');
      const destination = sourceOf('out.webp');

      await images.normalise(source, destination);

      expect(fs.existsSync(destination)).toBe(false);
    });

    it('refuses an image with more pixels than the cap, whatever it weighs', async () => {
      // 20000 squared is 400 megapixels in 69 bytes: the byte cap cannot see it, and decoding
      // it would cost a gigabyte of memory on the request thread.
      const source = writeHeaderOnlyPng('bomb.png', 20_000, 20_000);

      expect(fs.statSync(source).size).toBeLessThan(1_000);
      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.toEqual({
        ok: false,
        reason: 'dimensions',
      });
    });

    it('takes an image right at the cap', async () => {
      // The bound is inclusive, and a header claiming exactly the cap is decodable in
      // principle — so the refusal above is about the size, not about the shape of the file.
      const side = Math.floor(Math.sqrt(MAX_AVATAR_PIXELS));
      const source = writeHeaderOnlyPng('edge.png', side, side);

      await expect(images.normalise(source, sourceOf('out.webp'))).resolves.not.toMatchObject({
        reason: 'dimensions',
      });
    });

    it('reports a missing source rather than throwing', async () => {
      await expect(
        images.normalise(sourceOf('nothing-here.png'), sourceOf('out.webp')),
      ).resolves.toEqual({ ok: false, reason: 'unreadable' });
    });
  });

  describe("a failure that is the machine's, not the picture's", () => {
    it('throws rather than calling a good picture unreadable', async () => {
      // The destination cannot be written because its parent is a file. Whatever the cause —
      // this, a full disk, a volume mounted read-only — the upload must not come back telling
      // the user to try a different picture while nothing reaches the log.
      const source = await write('in.png', 300, 200, 'png');
      fs.writeFileSync(sourceOf('blocked'), 'not a directory');

      await expect(
        images.normalise(source, path.join(sourceOf('blocked'), 'out.webp')),
      ).rejects.toThrow();
    });
  });
});
