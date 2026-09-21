import { open } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { MEETING_FILE_ALLOWED_TYPES } from '@repo/shared';
import { fromTokenizer } from 'file-type';
import type { FileTypeResult } from 'file-type';
import { fromFile as openFileTokenizer } from 'strtok3';

/**
 * `file-type` names a few types differently from the allow-list. The list holds the names
 * clients expect; the mapping is confined to here.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'audio/vnd.wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
};

/** How much of an undetected file is read to decide whether it is text. */
const TEXT_SAMPLE_BYTES = 8 * 1024;

/**
 * Plain text, Markdown, and CSV have no magic bytes. When `file-type` detects nothing and the
 * bytes decode as UTF-8 with no NUL, the extension picks **only among these three**. Anything
 * else is rejected: an extension never elevates a file to a binary type, so `page.html`
 * renamed `page.pdf` is text with a `.pdf` extension, which is a 415.
 */
const TEXT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
};

/**
 * Decides a stored file's media type from its bytes, never from what the client claimed.
 *
 * `file-type` is pinned to 16.5.4, the last CJS release. 17+ is ESM-only: Node 24 would
 * `require()` it, but Jest's module loader cannot, and loading it there takes dynamic-import
 * gymnastics in both suites. It detects every binary type on the allow-list, including
 * DOCX/XLSX/PPTX by reading the zip's entries.
 */
@Injectable()
export class ContentSniffer {
  /** The allow-listed media type, or `null` for anything the API will not store. */
  async sniff(filePath: string, originalName: string): Promise<string | null> {
    let detected: FileTypeResult | undefined;

    try {
      detected = await detectFileType(filePath);
    } catch (error) {
      // Refused rather than typed some other way: no real file makes the parser skip back.
      if (error instanceof BackwardSkipError) {
        return null;
      }

      throw error;
    }

    if (detected !== undefined) {
      const mediaType = ALIASES[detected.mime] ?? detected.mime;

      return MEETING_FILE_ALLOWED_TYPES.includes(mediaType) ? mediaType : null;
    }

    if (!looksLikeText(await readHead(filePath))) {
      return null;
    }

    return TEXT_TYPES_BY_EXTENSION[path.extname(originalName.trim()).toLowerCase()] ?? null;
  }
}

/** A parser asked `detectFileType`'s tokenizer to move backwards. Never a failed read. */
class BackwardSkipError extends Error {}

/**
 * `file-type`'s `fromFile`, except that a skip of negative length throws `BackwardSkipError`
 * instead of moving the read position back.
 *
 * `file-type` 16 walks some structures by sizes read from the file, and a size smaller than the
 * header it came from is a negative skip that lands the walk on that header again, forever. ASF
 * is where it happens (GHSA-5v7r-6r5c-r473): a sub-object declaring a size of zero, which a
 * 64-byte upload is enough to carry. Refusing the ASF header at byte 0 was not enough, because
 * detection starts over after an ID3 tag — as many tags as the file holds — so the header can
 * sit at any offset. Refusing the backward skip closes the loop wherever it starts, and costs a
 * real file nothing: no format `file-type` detects skips back on purpose. The upstream fix is in
 * 21.3.1, beyond the version this build can load (see the class comment).
 */
async function detectFileType(filePath: string): Promise<FileTypeResult | undefined> {
  const tokenizer = await openFileTokenizer(filePath);
  const ignore = tokenizer.ignore.bind(tokenizer);

  tokenizer.ignore = async (length: number): Promise<number> => {
    if (length < 0) {
      throw new BackwardSkipError(`Refused a skip of ${String(length)} bytes`);
    }

    return ignore(length);
  };

  try {
    return await fromTokenizer(tokenizer);
  } finally {
    await tokenizer.close();
  }
}

/** The file's first `TEXT_SAMPLE_BYTES`, or all of it when it is shorter. */
async function readHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SAMPLE_BYTES, 0);

    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function looksLikeText(sample: Buffer): boolean {
  if (sample.includes(0)) {
    return false;
  }

  try {
    // `stream: true` tolerates a multi-byte sequence cut off at the sample boundary; anything
    // else that is not valid UTF-8 throws because of `fatal`.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });

    return true;
  } catch {
    return false;
  }
}
