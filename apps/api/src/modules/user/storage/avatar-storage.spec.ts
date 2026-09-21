import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigService } from '@nestjs/config';

import { AvatarStorage } from './avatar-storage';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function storageAt(root: string): AvatarStorage {
  return new AvatarStorage({ getOrThrow: () => root } as unknown as ConfigService);
}

describe('AvatarStorage', () => {
  let root: string;
  let storage: AvatarStorage;

  /** One user's key, as a row written before uploads had one key each still holds. */
  const key = (): string => `${USER_ID}.webp`;

  const writeTemp = (contents: string): string => {
    const source = path.join(storage.tempDir(), 'incoming');
    fs.writeFileSync(source, contents);

    return source;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-storage-'));
    storage = storageAt(root);
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

    it('gives every upload a key of its own, so no two ever name one object', () => {
      const first = storage.newKey();
      const second = storage.newKey();

      expect(first).not.toBe(second);
      // Still a key the traversal check accepts, which is what lets it reach the filesystem.
      expect(() => storage.pathOf(first)).not.toThrow();
    });

    it('still resolves the one-object-per-user keys written before that', () => {
      expect(() => storage.pathOf(`${USER_ID}.webp`)).not.toThrow();
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

  /**
   * Mirrors `meeting-file-storage.spec.ts`, and for its reasons: the case is about mode bits,
   * which Windows does not have and which root ignores, so it is skipped rather than asserted
   * on a machine where it cannot be observed. An earlier version of this pointed at a magic
   * path under `/proc` and hoped the host would refuse it — which passed on macOS, and on
   * Linux hung until Jest's five-second timeout killed it.
   */
  const describeUnlessWindows = process.platform === 'win32' ? describe.skip : describe;

  describeUnlessWindows('an unwritable root', () => {
    it('rejects init with the resolved path in the message', async () => {
      if (process.getuid?.() === 0) {
        // root ignores mode bits, so the case is not observable; nothing to assert.
        return;
      }

      const locked = path.join(root, 'locked');
      fs.mkdirSync(locked, { mode: 0o500 });

      try {
        await expect(storageAt(locked).onModuleInit()).rejects.toThrow(
          new RegExp(
            `Avatar storage at ${escapeForRegExp(path.join(locked, 'avatars'))} is not writable`,
          ),
        );
      } finally {
        // Restored so `afterEach` can remove the tree.
        fs.chmodSync(locked, 0o700);
      }
    });
  });
});

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
