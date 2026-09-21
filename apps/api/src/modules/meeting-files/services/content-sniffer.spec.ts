import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ContentSniffer } from './content-sniffer';

const FIXTURES = path.resolve(__dirname, '../../../../test/fixtures');
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const NUL = String.fromCodePoint(0);

describe('ContentSniffer', () => {
  const sniffer = new ContentSniffer();
  let scratch: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'content-sniffer-'));
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const scratchFile = (name: string, bytes: Buffer | string): string => {
    const filePath = path.join(scratch, name);
    fs.writeFileSync(filePath, bytes);

    return filePath;
  };

  it.each([
    ['sample.png', 'image/png'],
    ['sample.pdf', 'application/pdf'],
    ['sample.docx', WORD_TYPE],
    ['sample.txt', 'text/plain'],
    ['sample.md', 'text/markdown'],
    ['sample.csv', 'text/csv'],
  ])('detects %s as %s', async (name, expected) => {
    await expect(sniffer.sniff(path.join(FIXTURES, name), name)).resolves.toBe(expected);
  });

  it('never lets an extension elevate text to a binary type', async () => {
    await expect(sniffer.sniff(path.join(FIXTURES, 'page.html'), 'page.pdf')).resolves.toBeNull();
  });

  it('stores HTML named .txt as plain text — it is served as an attachment with nosniff', async () => {
    await expect(sniffer.sniff(path.join(FIXTURES, 'page.html'), 'notes.txt')).resolves.toBe(
      'text/plain',
    );
  });

  it('rejects HTML under its own extension', async () => {
    await expect(sniffer.sniff(path.join(FIXTURES, 'page.html'), 'page.html')).resolves.toBeNull();
  });

  it('is case-insensitive on the extension and ignores surrounding whitespace', async () => {
    await expect(sniffer.sniff(path.join(FIXTURES, 'sample.md'), ' NOTES.MD ')).resolves.toBe(
      'text/markdown',
    );
  });

  it('rejects a NUL byte in an otherwise textual file', async () => {
    const file = scratchFile('nul.txt', Buffer.from(`hello${NUL}world`));

    await expect(sniffer.sniff(file, 'nul.txt')).resolves.toBeNull();
  });

  it('rejects UTF-16 text, which is not valid UTF-8', async () => {
    const file = scratchFile('utf16.txt', Buffer.from('hello world', 'utf16le'));

    await expect(sniffer.sniff(file, 'utf16.txt')).resolves.toBeNull();
  });

  it('rejects invalid UTF-8 bytes', async () => {
    const file = scratchFile('bad.txt', Buffer.from([0x68, 0x69, 0xc3, 0x28]));

    await expect(sniffer.sniff(file, 'bad.txt')).resolves.toBeNull();
  });

  it('tolerates a multi-byte character cut at the sample boundary', async () => {
    // 8 KiB minus one byte of ASCII, then a two-byte character straddling the boundary.
    const file = scratchFile(
      'boundary.txt',
      Buffer.concat([Buffer.alloc(8 * 1024 - 1, 'a'), Buffer.from('é')]),
    );

    await expect(sniffer.sniff(file, 'boundary.txt')).resolves.toBe('text/plain');
  });

  it('maps WAV to the name on the allow-list', async () => {
    // RIFF....WAVE is enough for file-type to call it audio/vnd.wave.
    const wav = scratchFile('a.wav', Buffer.from(`RIFF${NUL}${NUL}${NUL}${NUL}WAVEfmt `));

    await expect(sniffer.sniff(wav, 'a.wav')).resolves.toBe('audio/wav');
  });

  it('rejects a detected type that is not on the allow-list', async () => {
    const zip = scratchFile('a.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]));

    await expect(sniffer.sniff(zip, 'a.zip')).resolves.toBeNull();
  });

  it('still finds an MP3 behind its ID3 tag', async () => {
    // Frame sync and an MPEG-1 Layer III header: what file-type reads once it skips the tag.
    const mp3 = scratchFile(
      'song.mp3',
      Buffer.concat([emptyId3Tag(), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400)]),
    );

    await expect(sniffer.sniff(mp3, 'song.mp3')).resolves.toBe('audio/mpeg');
  });

  // GHSA-5v7r-6r5c-r473. Without the sniffer's refusal these tests do not fail an assertion —
  // they time out, and the loop they started keeps running.
  describe('a file that would make file-type skip backwards', () => {
    it('refuses an ASF header at the start of the file', async () => {
      await expect(
        sniffer.sniff(scratchFile('loop.wmv', asfLoop()), 'loop.wmv'),
      ).resolves.toBeNull();
    }, 2_000);

    it('refuses one behind an ID3 tag, where file-type starts detection again', async () => {
      const file = scratchFile('id3.mp3', Buffer.concat([emptyId3Tag(), asfLoop()]));

      await expect(sniffer.sniff(file, 'id3.mp3')).resolves.toBeNull();
    }, 2_000);

    it('refuses one behind a chain of ID3 tags', async () => {
      const tags = [emptyId3Tag(), emptyId3Tag(), emptyId3Tag()];
      const file = scratchFile('id3-chain.mp3', Buffer.concat([...tags, asfLoop()]));

      await expect(sniffer.sniff(file, 'id3-chain.mp3')).resolves.toBeNull();
    }, 2_000);

    it('refuses one however many bytes follow it', async () => {
      const file = scratchFile(
        'id3-tail.mp3',
        Buffer.concat([emptyId3Tag(), asfLoop(), Buffer.alloc(64 * 1024)]),
      );

      await expect(sniffer.sniff(file, 'id3-tail.mp3')).resolves.toBeNull();
    }, 2_000);
  });
});

/**
 * An ASF header whose first sub-object declares a size of zero. Past the header GUID, file-type
 * 16 walks sub-objects by their declared size, so zero becomes a skip of minus 24 bytes that
 * lands the walk on the same sub-object forever.
 */
function asfLoop(): Buffer {
  const asf = Buffer.alloc(64);
  Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]).copy(asf);
  asf.fill(0x11, 30, 46);
  asf.writeBigUInt64LE(0n, 46);

  return asf;
}

/** An empty ID3v2.4 tag. file-type skips a tag and runs its detection again from the end of it. */
function emptyId3Tag(): Buffer {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}
