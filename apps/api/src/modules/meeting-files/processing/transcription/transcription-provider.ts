import type { Readable } from 'node:stream';

/**
 * The injection token for the port. A string token rather than the interface, because an
 * interface does not survive to runtime — and because it lets an e2e spec bind a fake without
 * importing anything from this directory.
 */
export const TRANSCRIPTION_PROVIDER = 'TRANSCRIPTION_PROVIDER';

/**
 * What the transcription worker needs from the outside world, and nothing more: bytes in,
 * text out. The worker never learns which server answered, which is what makes the server
 * configuration rather than code — and what lets every test run against a fake.
 *
 * The implementation must honour `signal`. The worker aborts a request that has outrun its
 * time limit, one whose claim is gone, and whatever is in flight at shutdown — and a provider
 * that ignores it holds a claim's lease for as long as it likes.
 *
 * **What an implementation throws is for the log, never for the user.** The worker decides
 * the reason a failed transcription carries from what ended the request, so nothing a
 * provider says — or a server said to it — can reach a row.
 */
export interface TranscriptionProvider {
  transcribe(stream: Readable, contentType: string, signal: AbortSignal): Promise<string>;
}

/**
 * What a provider throws when a recording was not transcribed, whatever the reason. Not for a
 * user to read: the worker that asked chooses the stored reason itself, from what ended the
 * request, so this carries what happened for the log — and never the endpoint's own words.
 */
export class TranscriptionRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranscriptionRequestError';
  }
}
