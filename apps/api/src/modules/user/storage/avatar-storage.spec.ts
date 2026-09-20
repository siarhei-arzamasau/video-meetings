import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigService } from '@nestjs/config';

import { AvatarStorage } from './avatar-storage';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('AvatarStorage', () => {
  let root: string;
  let storage: AvatarStorage;

  const key = (): string => storage.keyOf(USER_ID);

  const writeTemp = (contents: string): string => {
    const source = path.join(storage.tempDir(), 'incoming');
    fs.writeFileSync(source, contents);

    return source;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-storage-'));
    storage = new AvatarStorage({ getOrThrow: () => root } as unknown as ConfigService);
    await storage.onModuleInit();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('where things live', () => {
    it('keeps avatars in their own subtree of the shared storage root', () => {
      // The PRD's rule: the same root as meeting files, a subtree of its own. A flat layout
      // would put a user id and a meeting id in one namespace.
      expect(storage.pathOf(key())).toBe(path.join(root, 'avatars', `${USER_ID}.webp`));
      expect(storage.tempDir()).toBe(path.join(root, 'avatars', 'tmp'));
    });

    it('creates and probes the directory at boot rather than at the first upload', () => {
      expect(fs.existsSync(storage.tempDir())).toBe(true);
      // Nothing is left behind by the probe.
      expect(fs.readdirSync(storage.tempDir())).toEqual([]);
    });

    it('fails startup loudly when the root cannot be written', async () => {
      const unwritable = new AvatarStorage({
        getOrThrow: () => '/proc/nonexistent-avatar-root',
      } as unknown as ConfigService);

      await expect(unwritable.onModuleInit()).rejects.toThrow(/not writable/);
    });

    it('gives one user one key, whatever they upload', () => {
      expect(storage.keyOf(USER_ID)).toBe(`${USER_ID}.webp`);
    });
  });

  describe('the key check', () => {
    it.each([
      ['a path escaping the root', '../../../etc/passwd'],
      ['a nested path', 'a/b.webp'],
      ['a key with no extension', USER_ID],
      ['another extension', `${USER_ID}.png`],
      ['an empty key', ''],
      ['a key with a null byte', `${USER_ID}\0.webp`],
    ])('refuses %s before touching the filesystem', (_description, badKey) => {
      // The whole path-traversal defence, and every filesystem call in this class is behind
      // it — so this is the test that keeps it that way.
      expect(() => storage.pathOf(badKey)).toThrow(/Invalid avatar storage key/);
    });
  });

  describe('putting and removing', () => {
    it('moves a rendition into place and reads it back', async () => {
      await storage.put(key(), writeTemp('an image'));

      expect(fs.existsSync(path.join(storage.tempDir(), 'incoming'))).toBe(false);
      await expect(storage.stat(key())).resolves.toEqual({ size: 'an image'.length });
    });

    it('replaces a previous avatar rather than leaving two', async () => {
      await storage.put(key(), writeTemp('first'));
      await storage.put(key(), writeTemp('second, longer'));

      await expect(storage.stat(key())).resolves.toEqual({ size: 'second, longer'.length });
      expect(fs.readdirSync(path.join(root, 'avatars')).toSorted()).toEqual(
        [`${USER_ID}.webp`, 'tmp'].toSorted(),
      );
    });

    it('streams the stored bytes', async () => {
      await storage.put(key(), writeTemp('an image'));

      const chunks: Buffer[] = [];
      for await (const chunk of storage.openRead(key())) {
        chunks.push(Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks).toString()).toBe('an image');
    });

    it('removes an avatar, and removing a missing one is not an error', async () => {
      await storage.put(key(), writeTemp('an image'));

      await storage.remove(key());
      await expect(storage.remove(key())).resolves.toBeUndefined();

      expect(fs.existsSync(storage.pathOf(key()))).toBe(false);
    });
  });
});
