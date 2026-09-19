import type { MeetingFile, MeetingFileUpload } from '@repo/shared';

import { ApiError, completeUpload, createUpload, getUpload, putChunk } from './api-client';

/** One chunk of the file, as a byte range to slice. */
export interface ChunkPlan {
  index: number;
  start: number;
  /** Exclusive, as `Blob.slice` takes it. */
  end: number;
}

/**
 * How many times one chunk is re-sent after a network failure before the upload gives up.
 * Three, with a widening pause between them: a phone that changes cell or a laptop that wakes
 * from sleep is offline for seconds, not milliseconds, and a client that surfaces the first
 * `TypeError` makes the user retry something the network was about to allow.
 *
 * Only a network failure is retried. An `ApiError` is the server's considered answer — a 404
 * for an expired session, a 400 for a chunk that does not fit — and sending it again would
 * produce the same answer.
 */
export const CHUNK_RETRIES = 3;

const RETRY_DELAYS_MS = [500, 1_500, 3_500];

export interface ChunkedUploadOptions {
  /** Aborts the chunk in flight; the promise rejects with an `AbortError` `DOMException`. */
  signal?: AbortSignal;
  /** Bytes acknowledged over total, as a fraction in `[0, 1]`. */
  onProgress?: (fraction: number) => void;
  /**
   * A session id remembered for this file. When the server still has it and it describes this
   * file, only the missing chunks are sent; otherwise a new session is opened, which is what
   * makes a stale id harmless.
   */
  resumeFrom?: string;
  /** Called as soon as the session id is known — before any chunk — so the caller can store it. */
  onSession?: (uploadId: string) => void;
  /** Called once when a resume actually resumes, so the row can say so. */
  onResume?: (received: number, total: number) => void;
}

/** The API calls this module makes, injectable so a test needs no browser and no clock. */
export interface ChunkedUploadDeps {
  createUpload: typeof createUpload;
  getUpload: typeof getUpload;
  putChunk: typeof putChunk;
  completeUpload: typeof completeUpload;
  /** Waits between retries. Injected so a test does not sleep for five seconds. */
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const BROWSER_DEPS: ChunkedUploadDeps = {
  createUpload,
  getUpload,
  putChunk,
  completeUpload,
  delay: wait,
};

/**
 * The byte ranges of a file, given the chunk size the server chose. Pure, so the arithmetic
 * that decides what each `PUT` carries is testable without a file or a network.
 *
 * The last chunk is the remainder; every other one is exactly `chunkSize`, which is the rule
 * the server checks each chunk against.
 */
export function planChunks(size: number, chunkSize: number): ChunkPlan[] {
  if (size <= 0 || chunkSize <= 0) {
    return [];
  }

  return Array.from({ length: Math.ceil(size / chunkSize) }, (_, index) => ({
    index,
    start: index * chunkSize,
    end: Math.min((index + 1) * chunkSize, size),
  }));
}

/**
 * What identifies a file across a page reload: name, size, and last-modified date.
 *
 * A browser cannot keep a `File` handle across a reload, so a resumed upload always begins
 * with the user picking the file again. This is how the client recognises that they picked
 * the same one — and if it is wrong about that, the server's own checks catch it: a session
 * whose `size` or `name` disagrees is not reused, and a chunk that does not fit is a 400.
 */
export function fingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}:${String(file.size)}:${String(file.lastModified)}`;
}

/**
 * Uploads a file in chunks, sequentially, and returns the `MeetingFile` it became.
 *
 * Sequential on purpose: the bottleneck is the user's uplink, and parallel chunks would share
 * it without finishing sooner while making progress jump about. Each chunk that the server
 * acknowledges is one the client never sends again — that is the whole of resume, and it works
 * the same way after a dropped connection (the session is still in memory) and after a reload
 * (the session id comes from storage and the file is picked again).
 *
 * Progress is bytes acknowledged plus the chunk in flight, over the total, so a resumed upload
 * starts at the fraction it had reached rather than at zero.
 */
export async function uploadInChunks(
  token: string,
  meetingId: string,
  file: File,
  options: ChunkedUploadOptions = {},
  deps: ChunkedUploadDeps = BROWSER_DEPS,
): Promise<MeetingFile> {
  const { signal, onProgress, onSession, onResume } = options;

  throwIfAborted(signal);

  const session = await openSession(token, meetingId, file, options, deps);

  onSession?.(session.id);

  const received = new Set(session.receivedChunks);
  const plan = planChunks(file.size, session.chunkSize);
  const outstanding = plan.filter(({ index }) => !received.has(index));

  if (outstanding.length < plan.length) {
    onResume?.(plan.length - outstanding.length, plan.length);
  }

  // Bytes the server already has, so a resumed upload's percentage starts where it left off.
  let acknowledged = plan
    .filter(({ index }) => received.has(index))
    .reduce((total, { start, end }) => total + (end - start), 0);

  onProgress?.(acknowledged / file.size);

  // A reduce rather than a loop with an await in it: the chunks go one at a time, in order.
  await outstanding.reduce(async (previous, { index, start, end }) => {
    await previous;
    throwIfAborted(signal);

    const settled = acknowledged;

    await sendChunk(token, meetingId, session.id, index, file.slice(start, end), deps, {
      signal,
      onProgress: (fraction) => {
        onProgress?.(Math.min(1, (settled + fraction * (end - start)) / file.size));
      },
    });

    acknowledged = settled + (end - start);
    onProgress?.(acknowledged / file.size);
  }, Promise.resolve());

  throwIfAborted(signal);

  return deps.completeUpload(token, meetingId, session.id);
}

/**
 * The session to send into: the remembered one when the server still has it and it describes
 * this file, a new one otherwise.
 *
 * A remembered id that has expired, been aborted, completed, or belongs to a different file is
 * not an error — it is simply not a resume, and the upload starts over.
 */
async function openSession(
  token: string,
  meetingId: string,
  file: File,
  { resumeFrom }: ChunkedUploadOptions,
  deps: ChunkedUploadDeps,
): Promise<MeetingFileUpload> {
  if (resumeFrom !== undefined) {
    const existing = await deps.getUpload(token, meetingId, resumeFrom).catch((error: unknown) => {
      if (error instanceof ApiError) {
        return null;
      }

      throw error;
    });

    if (existing !== null && existing.size === file.size && existing.name === file.name) {
      return existing;
    }
  }

  return deps.createUpload(token, meetingId, file);
}

/**
 * One chunk, re-sent after a network failure with a widening pause, up to `CHUNK_RETRIES`
 * times. An `ApiError` and an abort both surface immediately: the first is an answer, the
 * second is the user's decision.
 */
async function sendChunk(
  token: string,
  meetingId: string,
  uploadId: string,
  index: number,
  chunk: Blob,
  deps: ChunkedUploadDeps,
  options: { signal?: AbortSignal; onProgress: (fraction: number) => void },
  attempt = 0,
): Promise<void> {
  try {
    await deps.putChunk(token, meetingId, uploadId, index, chunk, options);
  } catch (error) {
    if (attempt >= CHUNK_RETRIES || !isNetworkFailure(error)) {
      throw error;
    }

    await deps.delay(RETRY_DELAYS_MS[attempt] ?? 0, options.signal);
    await sendChunk(token, meetingId, uploadId, index, chunk, deps, options, attempt + 1);
  }
}

/**
 * A request that never reached the API. `fetch` and the XHR wrapper both report that as a
 * `TypeError`; anything carrying a status is the server's answer and is not retried.
 */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('The upload was aborted', 'AbortError');
  }
}

/** A pause that a cancel cuts short, so Cancel during a retry backoff is immediate. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('The upload was aborted', 'AbortError'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
