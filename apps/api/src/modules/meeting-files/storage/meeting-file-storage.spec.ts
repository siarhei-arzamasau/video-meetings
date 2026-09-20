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

  it('accepts the transcript suffix on a key', () => {
    expect(storage.pathOf(`${key}.transcript.txt`)).toBe(path.join(root, `${key}.transcript.txt`));
  });

  it('writeText writes UTF-8 beside the object, creating the directory', async () => {
    await storage.writeText(`${key}.transcript.txt`, 'Привет, коллеги. Good morning.');

    expect(fs.readFileSync(storage.pathOf(`${key}.transcript.txt`), 'utf8')).toBe(
      'Привет, коллеги. Good morning.',
    );
  });

  it('writeText overwrites rather than appending, so a retry leaves one transcript', async () => {
    await storage.writeText(`${key}.transcript.txt`, 'first pass');
    await storage.writeText(`${key}.transcript.txt`, 'second');

    expect(fs.readFileSync(storage.pathOf(`${key}.transcript.txt`), 'utf8')).toBe('second');
  });

  it('writeText rejects a key outside the two shapes', async () => {
    await expect(storage.writeText('../escape.txt', 'no')).rejects.toThrow(/Invalid storage key/);
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

  describe('chunk keys', () => {
    const uploadId = randomUUID();
    const chunkKey = (index: number): string => `uploads/${uploadId}/${String(index)}`;

    it('putChunk moves the source under uploads/<uploadId>/<index>', async () => {
      const source = path.join(storage.tempDir(), 'chunk-1');
      fs.writeFileSync(source, 'chunk');

      await storage.putChunk(chunkKey(0), source);

      expect(fs.existsSync(source)).toBe(false);
      expect(fs.readFileSync(path.join(root, 'uploads', uploadId, '0'), 'utf8')).toBe('chunk');
      await expect(storage.stat(chunkKey(0))).resolves.toEqual({ size: 5 });
    });

    it('a chunk sent twice overwrites the first, leaving one file', async () => {
      const first = path.join(storage.tempDir(), 'chunk-2a');
      const second = path.join(storage.tempDir(), 'chunk-2b');
      fs.writeFileSync(first, 'aaa');
      fs.writeFileSync(second, 'bbbb');

      await storage.putChunk(chunkKey(3), first);
      await storage.putChunk(chunkKey(3), second);

      expect(fs.readdirSync(path.join(root, 'uploads', uploadId))).toEqual(['3']);
      expect(fs.readFileSync(storage.pathOf(chunkKey(3)), 'utf8')).toBe('bbbb');
    });

    it('removeTree removes every chunk of one session and is idempotent', async () => {
      const source = path.join(storage.tempDir(), 'chunk-3');
      fs.writeFileSync(source, 'x');
      await storage.putChunk(chunkKey(0), source);

      await storage.removeTree(uploadId);
      await expect(storage.removeTree(uploadId)).resolves.toBeUndefined();
      expect(fs.existsSync(path.join(root, 'uploads', uploadId))).toBe(false);
    });

    it.each([
      ['a traversal in the id segment', 'uploads/../../etc/passwd'],
      ['a traversal in the index segment', `uploads/${randomUUID()}/../../etc/passwd`],
      ['a non-numeric index', `uploads/${randomUUID()}/one`],
      ['a negative index', `uploads/${randomUUID()}/-1`],
      ['a leading zero on the index', `uploads/${randomUUID()}/01`],
      ['a missing index', `uploads/${randomUUID()}`],
      ['a fourth segment', `uploads/${randomUUID()}/0/extra`],
      ['another prefix', `objects/${randomUUID()}/0`],
    ])('rejects %s before touching the filesystem', async (_description, badKey) => {
      expect(() => storage.pathOf(badKey)).toThrow(/Invalid storage key/);
      await expect(storage.putChunk(badKey, 'unused')).rejects.toThrow(/Invalid storage key/);
      await expect(storage.remove(badKey)).rejects.toThrow(/Invalid storage key/);
      expect(fs.readdirSync(root)).toEqual(['tmp']);
    });

    it.each([
      ['a traversal', '../../etc'],
      ['a path separator', `${randomUUID()}/0`],
      ['an empty id', ''],
    ])('removeTree rejects %s before touching the filesystem', async (_description, badId) => {
      await expect(storage.removeTree(badId)).rejects.toThrow(/Invalid upload id/);
      expect(fs.readdirSync(root)).toEqual(['tmp']);
    });
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
