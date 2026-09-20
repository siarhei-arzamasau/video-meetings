import type { ApiErrorResponse } from '@repo/shared';

const DEFAULT_BASE_URL = 'http://localhost:3001/api';

/** The API origin plus its global prefix, with any trailing slashes removed. */
export function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, '');
}

export function buildApiUrl(path: string): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalised}`;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The single boundary between the web app and the API — with one exception, `uploadMeetingFile`
 * below, which is an `XMLHttpRequest` because `fetch` cannot report upload progress.
 *
 * A 204 resolves to `undefined`: there is no body to parse, and reading one would throw.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, path));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** The same boundary for a binary response: the body as a `Blob`, the failure as an `ApiError`. */
export async function apiFetchBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(buildApiUrl(path), init);

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, path));
  }

  return response.blob();
}

/**
 * The API's own message, falling back to the status when there is not one.
 *
 * Worth the extra read: "That email is already registered" is not recoverable from a 409, and
 * a 400 carries one entry per broken validation rule. Anything a form can show a user has to
 * come from here.
 *
 * Nothing in it may throw. A failing response is not obliged to carry JSON — a proxy or a
 * crashed process answers with HTML — and an exception raised while reporting a failure would
 * replace it with a parse error nobody can trace back.
 */
export async function readErrorMessage(response: Response, path: string): Promise<string> {
  try {
    return messageOf(await response.json(), response.status, path);
  } catch {
    return fallbackMessage(response.status, path);
  }
}

/** The API's message from an already-parsed body, or the status fallback. Never throws. */
export function messageOf(body: unknown, status: number, path: string): string {
  return extractMessage(body) ?? fallbackMessage(status, path);
}

function fallbackMessage(status: number, path: string): string {
  return `Request to ${path} failed with ${String(status)}`;
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('message' in body)) {
    return undefined;
  }

  const { message } = body as { message: ApiErrorResponse['message'] | undefined };

  if (typeof message === 'string') {
    return message.trim() === '' ? undefined : message;
  }

  if (Array.isArray(message)) {
    // Joined into sentences: the pipe emits fragments ("password must be longer …"), one per
    // rule, and a list rendered as a single line reads as one run-on without the separators.
    const sentences = message.filter((entry) => typeof entry === 'string' && entry.trim() !== '');

    return sentences.length === 0 ? undefined : `${sentences.join('. ')}.`;
  }

  return undefined;
}

/**
 * Bearer credentials for a JWT-guarded endpoint.
 *
 * Internal to this module: it is exported for the wrapper files beside it, never through
 * `index.ts`. `apiFetch` is the boundary, and a header builder the app could reach is an
 * invitation to assemble a request somewhere else. It exists at all because `Bearer ` carries
 * one significant space, and omitting it produces a bare 401 indistinguishable from an expired
 * token.
 *
 * A plain object, never a `Headers` instance: `apiFetch` spreads `init.headers` into an object
 * literal, and spreading a `Headers` yields `{}` — which would drop the token silently.
 */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface UploadOptions {
  /** Aborts the request; the promise rejects with an `AbortError` `DOMException`. */
  signal?: AbortSignal;
  /** Called with a fraction in `[0, 1]` whenever the browser reports upload progress. */
  onProgress?: (fraction: number) => void;
}

/** Injectable for tests only; production always uses the browser's. */
export type XhrFactory = () => XMLHttpRequest;

/**
 * The `XMLHttpRequest` half of this module, shared by the single-request upload and by each
 * chunk of a chunked one. Same contract as `apiFetch` — the API's own message in an
 * `ApiError`, `buildApiUrl` for the URL, the token as a bearer header — plus the two things
 * `fetch` cannot do: report upload progress and be aborted mid-body.
 */
export function sendWithProgress<T>(
  {
    method,
    path,
    token,
    body,
    contentType,
  }: {
    method: string;
    path: string;
    token: string;
    body: XMLHttpRequestBodyInit;
    contentType?: string;
  },
  { signal, onProgress }: UploadOptions,
  createXhr: XhrFactory,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The upload was aborted', 'AbortError'));

      return;
    }

    const xhr = createXhr();
    const abort = (): void => xhr.abort();

    signal?.addEventListener('abort', abort, { once: true });

    xhr.open(method, buildApiUrl(path));
    xhr.setRequestHeader('authorization', `Bearer ${token}`);

    if (contentType !== undefined) {
      xhr.setRequestHeader('content-type', contentType);
    }

    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });

    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', abort);

      if (xhr.status >= 200 && xhr.status < 300) {
        // A 204 carries no body, and `apiFetch` resolves those to `undefined` too — a chunk's
        // caller must not have to know that a real XHR reports the absence as `null`.
        resolve((xhr.status === 204 ? undefined : xhr.response) as T);
      } else {
        reject(new ApiError(xhr.status, messageOf(xhr.response, xhr.status, path)));
      }
    });

    xhr.addEventListener('error', () => {
      signal?.removeEventListener('abort', abort);
      reject(new TypeError('Failed to fetch'));
    });

    xhr.addEventListener('abort', () => {
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('The upload was aborted', 'AbortError'));
    });

    xhr.send(body);
  });
}
