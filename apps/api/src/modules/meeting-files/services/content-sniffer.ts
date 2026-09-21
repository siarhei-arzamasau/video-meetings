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

/** How much of a file is read up front: enough to decide whether an undetected one is text. */
const TEXT_SAMPLE_BYTES = 8 * 1024;

/**
 * The first bytes of an ASF header's GUID — all `file-type` 16 checks before it walks the
 * header's sub-objects by their declared sizes, and a sub-object that declares a size of zero
 * rewinds that walk onto itself forever (GHSA-5v7r-6r5c-r473). A 64-byte upload is enough to
 * leave a loop running for good. The fix shipped in 21.3.1, beyond the version this build can
 * load (see the class comment), so the prefix is refused before the parser runs. ASF is not on
 * the allow-list, so the answer is the 415 it would have been anyway, without the loop.
 */
const ASF_HEADER_PREFIX = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]);

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
    const head = await readHead(filePath);

    if (head.subarray(0, ASF_HEADER_PREFIX.length).equals(ASF_HEADER_PREFIX)) {
      return null;
    }

    const detected = await fromFile(filePath);

    if (detected !== undefined) {
      const mediaType = ALIASES[detected.mime] ?? detected.mime;

      return MEETING_FILE_ALLOWED_TYPES.includes(mediaType) ? mediaType : null;
    }

    if (!looksLikeText(head)) {
      return null;
    }

    return TEXT_TYPES_BY_EXTENSION[path.extname(originalName.trim()).toLowerCase()] ?? null;
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
