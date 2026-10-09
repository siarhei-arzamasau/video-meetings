import { ApiError, buildApiUrl, messageOf } from './core';

export interface UploadOptions {
  /** Aborts the request; the promise rejects with an `AbortError` `DOMException`. */
  signal?: AbortSignal;
  /** Called with a fraction in `[0, 1]` whenever the browser reports upload progress. */
  onProgress?: (fraction: number) => void;
}

/** Injectable for tests only; production always uses the browser's. */
export type XhrFactory = () => XMLHttpRequest;

/**
 * How long an upload may go without a byte moving or an answer arriving before it is treated
 * as a connection that dropped. A minute, so that a slow connection that is still moving never
 * trips it: progress is reported as bytes leave, however few.
 */
export const UPLOAD_STALL_MS = 60_000;

interface UploadRequest {
  method: string;
  path: string;
  token: string;
  body: XMLHttpRequestBodyInit;
  contentType?: string;
}

/**
 * The `XMLHttpRequest` half of this module, shared by the single-request upload and by each
 * chunk of a chunked one. Same contract as `apiFetch` — the API's own message in an
 * `ApiError`, `buildApiUrl` for the URL, the token as a bearer header — plus the two things
 * `fetch` cannot do: report upload progress and be aborted mid-body.
 *
 * **A request that stops moving is ended as a network failure, not left to hang.** A
 * connection can go quiet without ever resetting, and an `XMLHttpRequest` then reports
 * nothing at all: the row sat at its percentage for good, and the only control left was
 * Cancel, which drops a chunked upload's session and with it the resume the feature exists
 * for. Rejected as the `TypeError` a failed request is, a stalled chunk is re-sent by
 * `uploadInChunks` like any other dropped one.
 */
export function sendWithProgress<T>(
  request: UploadRequest,
  { signal, onProgress }: UploadOptions,
  createXhr: XhrFactory,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());

      return;
    }

    const xhr = open(createXhr(), request);
    const abort = (): void => xhr.abort();
    const stall = watchForStall(xhr);
    const settle = (outcome: () => void): void => {
      signal?.removeEventListener('abort', abort);
      stall.stop();
      outcome();
    };

    signal?.addEventListener('abort', abort, { once: true });

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });
    xhr.addEventListener('load', () => settle(() => answer<T>(xhr, request.path, resolve, reject)));
    xhr.addEventListener('error', () => settle(() => reject(networkFailure())));
    // Cancel and a stall both end the request by aborting it; only one of them is the user's.
    xhr.addEventListener('abort', () =>
      settle(() => reject(stall.hasFired() ? networkFailure() : abortError())),
    );

    xhr.send(request.body);
  });
}

function open(
  xhr: XMLHttpRequest,
  { method, path, token, contentType }: UploadRequest,
): XMLHttpRequest {
  xhr.open(method, buildApiUrl(path));
  xhr.setRequestHeader('authorization', `Bearer ${token}`);

  if (contentType !== undefined) {
    xhr.setRequestHeader('content-type', contentType);
  }

  xhr.responseType = 'json';

  return xhr;
}

function answer<T>(
  xhr: XMLHttpRequest,
  path: string,
  resolve: (value: T) => void,
  reject: (reason: unknown) => void,
): void {
  if (xhr.status >= 200 && xhr.status < 300) {
    // A 204 carries no body, and `apiFetch` resolves those to `undefined` too — a chunk's
    // caller must not have to know that a real XHR reports the absence as `null`.
    resolve((xhr.status === 204 ? undefined : xhr.response) as T);
  } else {
    reject(new ApiError(xhr.status, messageOf(xhr.response, xhr.status, path)));
  }
}

interface StallWatch {
  stop(): void;
  hasFired(): boolean;
}

/**
 * Aborts `xhr` once `UPLOAD_STALL_MS` passes with no upload progress. The clock starts with
 * the request and is put back by every progress event, so what it measures is silence — on
 * the way up, and while the answer is awaited once the body has gone.
 */
function watchForStall(xhr: XMLHttpRequest): StallWatch {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      xhr.abort();
    }, UPLOAD_STALL_MS);
  };

  xhr.upload.addEventListener('progress', arm);
  arm();

  return { stop: () => clearTimeout(timer), hasFired: () => fired };
}

/** What `fetch` rejects with when a request never reached the API; callers retry on it. */
const networkFailure = (): TypeError => new TypeError('Failed to fetch');

const abortError = (): DOMException => new DOMException('The upload was aborted', 'AbortError');
