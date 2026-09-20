import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AVATAR_SIZE_PIXELS } from '@repo/shared';
import sharp from 'sharp';

import { AvatarImage } from './avatar-image';

/**
 * Real `sharp` on real files, not a mock. The whole value of this service is what comes out
 * the other end — one square, always the same size, whatever went in — and a mocked `sharp`
 * would assert the arguments this file passes rather than the property the PRD asks for.
 */
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

    it('reports a missing source rather than throwing', async () => {
      await expect(
        images.normalise(sourceOf('nothing-here.png'), sourceOf('out.webp')),
      ).resolves.toEqual({ ok: false, reason: 'unreadable' });
    });
  });
});
