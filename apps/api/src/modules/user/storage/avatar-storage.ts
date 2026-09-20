import fs from 'node:fs';
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** A uuid as Prisma generates one. Never a segment a client chose. */
const KEY_PATTERN = /^[0-9a-f-]{36}\.webp$/;

/** Where avatars live under the storage root, beside `meeting-files`' own subtrees. */
const AVATARS_DIR = 'avatars';

/** Where an upload lands before it is decoded, and where the normalised rendition is written
 *  before it is moved into place. Under the same root, so the move is a rename. */
const TEMP_DIR = 'tmp';

/**
 * Avatar storage over one directory on the local filesystem.
 *
 * **Its own class rather than a reuse of `MeetingFileStorage`, and that is deliberate.** The
 * two share a root directory — `MEETING_FILES_DIR`, as the PRD asks — and nothing else: this
 * one's keys are a different shape, it has no chunk tree and no temp-file protocol for a
 * hundred megabytes, and injecting the meeting-files provider here would mean the user module
 * reaching into another module's service rather than going through its module, which the root
 * guide forbids. The cost is this file; the alternative was a dependency between two modules
 * that have no reason to know about each other.
 *
 * **One object per user, at `avatars/<userId>.webp`.** Replacing an avatar renames over the
 * old one, which is atomic, so there is no window in which a request could read a half-written
 * image. That the key does not change is also why the user row carries a version.
 */
@Injectable()
export class AvatarStorage implements OnModuleInit {
  private readonly logger = new Logger(AvatarStorage.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    // Relative to the working directory, which for `pnpm dev` and the Dockerfile is `apps/api`.
    this.root = path.join(
      path.resolve(process.cwd(), config.getOrThrow<string>('MEETING_FILES_DIR')),
      AVATARS_DIR,
    );
  }

  /** Created and probed at boot, so a bad path fails startup rather than the first upload —
   *  the same rule `MeetingFileStorage` follows for the root it shares. */
  async onModuleInit(): Promise<void> {
    const probe = path.join(this.tempDir(), `.probe-${String(process.pid)}`);

    try {
      await mkdir(this.tempDir(), { recursive: true });
      await writeFile(probe, '');
      await unlink(probe);
    } catch (error) {
      throw new Error(`Avatar storage at ${this.root} is not writable: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    this.logger.log(`Avatar storage at ${this.root}`);
  }

  /** Where multipart uploads land, and where the normalised rendition is written. */
  tempDir(): string {
    return path.join(this.root, TEMP_DIR);
  }

  /** The key one user's avatar is stored under. Derived, never taken from a request. */
  keyOf(userId: string): string {
    return `${userId}.webp`;
  }

  /** The absolute path of a key, for the one consumer (`sharp`) that wants a path. */
  pathOf(key: string): string {
    return path.join(this.root, assertKey(key));
  }

  /**
   * Moves a normalised rendition into place, replacing whatever was there.
   *
   * `rename` within one filesystem is atomic — the temp directory is under this root for that
   * reason — so a request reading the avatar sees either the old image or the new one, never
   * a partial write. No `fsync` first, unlike a meeting file: nothing here promises the user
   * their bytes are durable, and an avatar lost to a power cut is one the user re-uploads.
   */
  async put(key: string, sourcePath: string): Promise<void> {
    const destination = this.pathOf(key);

    await mkdir(path.dirname(destination), { recursive: true });
    await rename(sourcePath, destination);
  }

  openRead(key: string): fs.ReadStream {
    return fs.createReadStream(this.pathOf(key));
  }

  async stat(key: string): Promise<{ size: number }> {
    const { size } = await stat(this.pathOf(key));

    return { size };
  }

  /** Idempotent: a missing object is a removed object. */
  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/**
 * The whole path-traversal defence, and it lives here so every filesystem call is behind it.
 * Keys are built by `keyOf` from an id Prisma generated; nothing derived from a request ever
 * reaches this.
 */
function assertKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`Invalid avatar storage key: ${JSON.stringify(key)}`);
  }

  return key;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
