import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UPLOAD_STALL_MS, putChunk } from './api-client';

const TOKEN = 'header.payload.signature';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '66666666-6666-4666-8666-666666666666';

/** The members of `XMLHttpRequest` the upload transport touches, and the events to fire. */
class FakeXhr {
  status = 0;
  response: unknown = null;
  responseType = '';
  aborted = false;
  readonly upload = new EventTarget();
  private readonly target = new EventTarget();

  open(): void {}

  setRequestHeader(): void {}

  send(): void {}

  addEventListener(type: string, listener: EventListener): void {
    this.target.addEventListener(type, listener);
  }

  abort(): void {
    this.aborted = true;
    this.target.dispatchEvent(new Event('abort'));
  }

  respond(status: number): void {
    this.status = status;
    this.target.dispatchEvent(new Event('load'));
  }

  progress(loaded: number, total: number): void {
    this.upload.dispatchEvent(
      new ProgressEvent('progress', { lengthComputable: true, loaded, total }),
    );
  }
}

/** Starts one chunk on its way and hands back the request and how it ended, once it has. */
function sendChunk(signal?: AbortSignal): { xhr: FakeXhr; outcome: () => unknown } {
  const xhr = new FakeXhr();
  let outcome: unknown = 'pending';

  putChunk(
    TOKEN,
    MEETING_ID,
    UPLOAD_ID,
    0,
    new Blob(['chunk']),
    { signal },
    () => xhr as unknown as XMLHttpRequest,
  ).then(
    () => {
      outcome = 'stored';
    },
    (error: unknown) => {
      outcome = error;
    },
  );

  return { xhr, outcome: () => outcome };
}

/**
 * A connection can go quiet without resetting, and an `XMLHttpRequest` then reports nothing:
 * no error, no end. The transport ends such a request itself, as the network failure a
 * chunked upload already knows how to retry.
 */
describe('an upload that stops moving', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is ended as a network failure once nothing has moved for the stall limit', async () => {
    const { xhr, outcome } = sendChunk();

    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    expect(xhr.aborted).toBe(false);
    expect(outcome()).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);

    expect(xhr.aborted).toBe(true);
    // The error a request that never arrived is reported as, which is what gets it re-sent.
    expect(outcome()).toBeInstanceOf(TypeError);
    expect((outcome() as TypeError).message).toBe('Failed to fetch');
  });

  it('is left alone for as long as bytes keep leaving, however slowly', async () => {
    const { xhr, outcome } = sendChunk();

    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    xhr.progress(1, 5);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    xhr.progress(2, 5);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);

    expect(xhr.aborted).toBe(false);
    expect(outcome()).toBe('pending');
  });

  it('is ended while the answer is awaited, after the whole body has gone', async () => {
    const { xhr, outcome } = sendChunk();

    xhr.progress(5, 5);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS);

    expect(xhr.aborted).toBe(true);
    expect(outcome()).toBeInstanceOf(TypeError);
  });

  it('stops watching once the request is answered', async () => {
    const { xhr, outcome } = sendChunk();

    xhr.respond(204);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS * 2);

    expect(outcome()).toBe('stored');
    expect(xhr.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Cancel aborts the same request the stall does; it must stay the user's decision, which
  // nothing retries.
  it('still reports a cancel as an abort, not as a failure to retry', async () => {
    const controller = new AbortController();
    const { outcome } = sendChunk(controller.signal);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(outcome()).toBeInstanceOf(DOMException);
    expect((outcome() as DOMException).name).toBe('AbortError');
    expect(vi.getTimerCount()).toBe(0);
  });
});
