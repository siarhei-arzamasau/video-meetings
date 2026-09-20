import type { Readable } from 'node:stream';

/**
 * The injection token for the port. A string token rather than the interface, because an
 * interface does not survive to runtime — and because it lets an e2e spec bind a fake without
 * importing anything from this directory.
 */
export const TRANSCRIPTION_PROVIDER = 'TRANSCRIPTION_PROVIDER';

/**
 * What the transcription step needs from the outside world, and nothing more: bytes in, text
 * out. The step never learns which vendor answered, which is what makes the vendor
 * configuration rather than code — and what lets every test run against a fake.
 *
 * The implementation must honour `signal`: the step's caller aborts a transcription that has
 * outrun its timeout, and a provider that ignores it holds a worker's lease for ever.
 */
export interface TranscriptionProvider {
  transcribe(stream: Readable, contentType: string, signal: AbortSignal): Promise<string>;
}
