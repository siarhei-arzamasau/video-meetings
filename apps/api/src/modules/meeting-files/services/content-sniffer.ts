import { open } from 'node:fs/promises';
import path from 'node:path';

import { Injectable } from '@nestjs/common';
import { MEETING_FILE_ALLOWED_TYPES } from '@repo/shared';
import { fromFile } from 'file-type';

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
 * `file-type` is pinned to 16.5.4, the last CJS release: 17+ is ESM-only, which the CJS build
 * and ts-jest cannot load without dynamic-import gymnastics. It detects every binary type on
 * the allow-list, including DOCX/XLSX/PPTX by reading the zip's entries.
 */
@Injectable()
export class ContentSniffer {
  /** The allow-listed media type, or `null` for anything the API will not store. */
  async sniff(filePath: string, originalName: string): Promise<string | null> {
    const detected = await fromFile(filePath);

    if (detected !== undefined) {
      const mediaType = ALIASES[detected.mime] ?? detected.mime;

      return MEETING_FILE_ALLOWED_TYPES.includes(mediaType) ? mediaType : null;
    }

    if (!(await looksLikeText(filePath))) {
      return null;
    }

    return TEXT_TYPES_BY_EXTENSION[path.extname(originalName.trim()).toLowerCase()] ?? null;
  }
}

async function looksLikeText(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TEXT_SAMPLE_BYTES, 0);
    const sample = buffer.subarray(0, bytesRead);

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
  } finally {
    await handle.close();
  }
}
