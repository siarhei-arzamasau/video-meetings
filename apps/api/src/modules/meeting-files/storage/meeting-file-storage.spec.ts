import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigService } from '@nestjs/config';

import { MeetingFileStorage } from './meeting-file-storage';

function storageAt(root: string): MeetingFileStorage {
  return new MeetingFileStorage({ getOrThrow: () => root } as unknown as ConfigService);
}

async function readAll(stream: fs.ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

describe('MeetingFileStorage', () => {
  let root: string;
  let storage: MeetingFileStorage;
  const key = `${randomUUID()}/${randomUUID()}`;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-file-storage-'));
    storage = storageAt(root);
    await storage.onModuleInit();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the root and the temp directory at init', () => {
    expect(fs.statSync(path.join(root, 'tmp')).isDirectory()).toBe(true);
    expect(storage.tempDir()).toBe(path.join(root, 'tmp'));
  });

  it('resolves a relative directory against the working directory', () => {
    const relative = storageAt('storage');

    expect(relative.tempDir()).toBe(path.resolve(process.cwd(), 'storage', 'tmp'));
  });

  it('put moves the source into place under the key, and the source is gone', async () => {
    const source = path.join(storage.tempDir(), 'upload-1');
    fs.writeFileSync(source, 'hello');

    await storage.put(key, source);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(storage.pathOf(key), 'utf8')).toBe('hello');
    await expect(storage.stat(key)).resolves.toEqual({ size: 5 });
  });

  it('openRead streams the stored bytes', async () => {
    const source = path.join(storage.tempDir(), 'upload-2');
    fs.writeFileSync(source, Buffer.from([1, 2, 3, 4]));
    await storage.put(key, source);

    await expect(readAll(storage.openRead(key))).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('remove is idempotent — a second call does not throw', async () => {
    const source = path.join(storage.tempDir(), 'upload-3');
    fs.writeFileSync(source, 'x');
    await storage.put(key, source);

    await storage.remove(key);
    await expect(storage.remove(key)).resolves.toBeUndefined();
    expect(fs.existsSync(storage.pathOf(key))).toBe(false);
  });

  it('accepts the thumbnail suffix on a key', () => {
    expect(storage.pathOf(`${key}.thumb.webp`)).toBe(path.join(root, `${key}.thumb.webp`));
  });

  it.each([
    ['a parent reference', '../etc/passwd'],
    ['a leading slash', `/${randomUUID()}/${randomUUID()}`],
    ['a bare file id', randomUUID()],
    ['a third segment', `${randomUUID()}/${randomUUID()}/more`],
    ['an unexpected suffix', `${randomUUID()}/${randomUUID()}.html`],
    ['an empty key', ''],
  ])('rejects %s before touching the filesystem', async (_description, badKey) => {
    expect(() => storage.pathOf(badKey)).toThrow(/Invalid storage key/);
    await expect(storage.remove(badKey)).rejects.toThrow(/Invalid storage key/);
    await expect(storage.stat(badKey)).rejects.toThrow(/Invalid storage key/);
    expect(() => storage.openRead(badKey)).toThrow(/Invalid storage key/);
    // Nothing was created on the way to the rejection.
    expect(fs.readdirSync(root)).toEqual(['tmp']);
  });

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
            `storage at ${locked.replaceAll(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} is not writable`,
          ),
        );
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    });
  });
});
