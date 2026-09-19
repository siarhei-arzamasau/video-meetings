import type {
  ApiErrorResponse,
  AuthResponse,
  Credentials,
  HealthResponse,
  Meeting,
  MeetingFile,
  User,
} from '@repo/shared';

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
async function apiFetchBlob(path: string, init?: RequestInit): Promise<Blob> {
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
async function readErrorMessage(response: Response, path: string): Promise<string> {
  try {
    return messageOf(await response.json(), response.status, path);
  } catch {
    return fallbackMessage(response.status, path);
  }
}

/** The API's message from an already-parsed body, or the status fallback. Never throws. */
function messageOf(body: unknown, status: number, path: string): string {
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

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health');
}

/**
 * Creates an account. A 409 means the address is taken; a 400 means the credentials broke a
 * rule `validateEmail`/`validatePassword` did not catch first.
 */
export function register(credentials: Credentials): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

/**
 * Exchanges credentials for a token.
 *
 * A 401 carries one deliberate message for both an unknown address and a wrong password — the
 * API refuses to distinguish them, so there is nothing to show but that sentence and nothing
 * to attribute it to. Anything that tells the two apart here would undo the API's defence.
 */
export function login(credentials: Credentials): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}

/**
 * Bearer credentials for a JWT-guarded endpoint.
 *
 * Private on purpose. `apiFetch` is the boundary, and an exported header builder is an
 * invitation to assemble a request somewhere else. It exists at all because `Bearer ` carries
 * one significant space, and omitting it produces a bare 401 indistinguishable from an expired
 * token.
 *
 * A plain object, never a `Headers` instance: `apiFetch` spreads `init.headers` into an object
 * literal, and spreading a `Headers` yields `{}` — which would drop the token silently.
 */
function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * The signed-in user, as the guard that authenticated the request loaded them.
 *
 * The token is an argument rather than something this module fetches for itself. That keeps the
 * credential opt-in — `register`, `login`, and `getHealth` must never send one — keeps this
 * file runnable where there is no browser, and keeps the eventual move to an `HttpOnly` cookie
 * local to these two functions: the parameter goes away and `credentials: 'include'` replaces
 * it.
 *
 * A 401 means the token is absent, malformed, expired, or names a user who no longer exists.
 * The API declines to say which, and all four mean the same thing to a caller — signed out.
 */
export function getMe(token: string): Promise<User> {
  return apiFetch<User>('/auth/me', { headers: authHeaders(token) });
}

/**
 * Every meeting the user hosts or attends, ascending by `scheduledAt`.
 *
 * The endpoint takes no query parameters — no page, no filter, no sort — so this is the whole
 * list and narrowing it is the caller's job. See `src/lib/meetings.ts`.
 *
 * Returned as a `ReadonlyArray` although the API's own type is an array: the caller holds this
 * in React state, and the readonly type makes an in-place `.sort()` a compile error.
 */
export function listMeetings(token: string): Promise<ReadonlyArray<Meeting>> {
  return apiFetch<Meeting[]>('/meetings', { headers: authHeaders(token) });
}

/** One meeting the user hosts or attends. A 404 covers both "no such meeting" and "not yours". */
export function getMeeting(token: string, meetingId: string): Promise<Meeting> {
  return apiFetch<Meeting>(`/meetings/${meetingId}`, { headers: authHeaders(token) });
}

/** Every non-deleted file of a meeting, newest first as the API orders them. */
export function listMeetingFiles(
  token: string,
  meetingId: string,
): Promise<ReadonlyArray<MeetingFile>> {
  return apiFetch<MeetingFile[]>(`/meetings/${meetingId}/files`, { headers: authHeaders(token) });
}

/** Soft delete. A 404 means the file is gone, or the caller is neither uploader nor host. */
export function deleteMeetingFile(token: string, meetingId: string, fileId: string): Promise<void> {
  return apiFetch<void>(`/meetings/${meetingId}/files/${fileId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

/**
 * The original bytes. A `Blob` rather than a URL: the token lives in `localStorage` and cannot
 * ride on a plain `<a href>`, so the caller turns this into an object URL and clicks it.
 */
export function downloadMeetingFile(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<Blob> {
  return apiFetchBlob(`/meetings/${meetingId}/files/${fileId}/content`, {
    headers: authHeaders(token),
  });
}

/** The WebP thumbnail, for the same reason as a `Blob`: an `<img src>` cannot carry the token. */
export function fetchThumbnail(token: string, meetingId: string, fileId: string): Promise<Blob> {
  return apiFetchBlob(`/meetings/${meetingId}/files/${fileId}/thumbnail`, {
    headers: authHeaders(token),
  });
}

export interface UploadOptions {
  /** Aborts the request; the promise rejects with an `AbortError` `DOMException`. */
  signal?: AbortSignal;
  /** Called with a fraction in `[0, 1]` whenever the browser reports upload progress. */
  onProgress?: (fraction: number) => void;
}

/** Injectable for tests only; production always uses the browser's. */
type XhrFactory = () => XMLHttpRequest;

/**
 * One file as `multipart/form-data`, field `file`.
 *
 * The only non-`fetch` call in this module, and deliberately so: `fetch` cannot report upload
 * progress, and the PRD asks for a percentage when the browser can give one. Everything else
 * about it matches `apiFetch` — the token as the first argument, `ApiError` with the API's
 * own message on a non-2xx, and the URL from `buildApiUrl`.
 */
export function uploadMeetingFile(
  token: string,
  meetingId: string,
  file: File,
  { signal, onProgress }: UploadOptions = {},
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<MeetingFile> {
  const path = `/meetings/${meetingId}/files`;

  return new Promise<MeetingFile>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The upload was aborted', 'AbortError'));

      return;
    }

    const xhr = createXhr();
    const abort = (): void => xhr.abort();

    signal?.addEventListener('abort', abort, { once: true });

    xhr.open('POST', buildApiUrl(path));
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });

    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', abort);

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as MeetingFile);
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

    const body = new FormData();
    body.append('file', file, file.name);
    xhr.send(body);
  });
}
