import type {
  ApiErrorResponse,
  AuthResponse,
  Credentials,
  HealthResponse,
  Meeting,
  MeetingFile,
  MeetingFileUpload,
  UpdateDisplayNameRequest,
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
    const sentences = message
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => terminate(entry.trim()));

    return sentences.length === 0 ? undefined : sentences.join(' ');
  }

  return undefined;
}

/**
 * A fragment gains a full stop; a sentence that brought its own keeps it.
 *
 * Terminated one entry at a time rather than once over the joined string, because the entries
 * are not all fragments. class-validator's defaults are ("email must be an email"), but a rule
 * carrying its own `message` sends a written sentence — `DISPLAY_NAME_MESSAGE` is one — and a
 * full stop appended to that rendered "…must be 1–80 characters.." under the field that had
 * just shown the same sentence correctly.
 */
function terminate(sentence: string): string {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
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
 * Renames the caller. There is no user id to send: the endpoint acts on whoever the token
 * names, and one that took an id would be one that could be pointed at somebody else.
 *
 * `PATCH`, and the answer is the whole updated user — so a caller holding the signed-in user
 * in memory replaces it with this rather than following up with `getMe`.
 *
 * A 400 means the name broke a bound `validateDisplayName` did not catch first, and its
 * message is `DISPLAY_NAME_MESSAGE` — the same constant the form renders, so the sentence the
 * field shows is the same either way.
 */
export function updateDisplayName(token: string, displayName: string): Promise<User> {
  return apiFetch<User>('/users/me', {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ displayName } satisfies UpdateDisplayNameRequest),
  });
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

/**
 * The copy for a 200 that is not a stream — a proxy's interstitial, a dev server's HTML.
 * Not a status, because the status is fine; what is wrong is what came back.
 */
export const NOT_AN_EVENT_STREAM_MESSAGE = 'The server did not send an event stream.';

/**
 * Opens this meeting's file event stream. The caller reads the body with `readEventStream`.
 *
 * Not `apiFetch`: there is nothing to parse and the body is the point. It is still the same
 * boundary — `buildApiUrl` for the URL, the bearer header, and a non-2xx as an `ApiError`
 * carrying the API's own message, so a 401 here reaches the caller as the 401 every other
 * call produces and goes down the same clear-and-redirect path.
 *
 * **The content type is checked rather than assumed.** A proxy or a misconfigured dev server
 * can answer 200 with HTML, which the parser would read as a stream that carried nothing and
 * ended — indistinguishable from a healthy stream closing, and so a reconnect loop. The
 * `ApiError` thrown instead carries the response's own status, not 401, so nothing downstream
 * mistakes it for an expired token.
 *
 * `signal` aborts the request and, with it, the body the caller is reading.
 */
export async function openMeetingFileEvents(
  token: string,
  meetingId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  const path = `/meetings/${meetingId}/files/events`;
  const response = await fetch(buildApiUrl(path), {
    headers: { ...authHeaders(token), accept: 'text/event-stream' },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, path));
  }

  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // Nothing is going to read this body, and a stream left open holds a connection.
    await response.body?.cancel();
    throw new ApiError(response.status, NOT_AN_EVENT_STREAM_MESSAGE);
  }

  return response;
}

/**
 * Sends a `failed` file back through the pipeline. The answer is the file as `uploaded`, so
 * the row goes back to Processing and the list's poll picks it up again. A 409 means it is no
 * longer failed — someone else retried it, or the worker finished it — and a 404 means the
 * caller is neither uploader nor host.
 */
export function retryMeetingFile(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<MeetingFile> {
  return apiFetch<MeetingFile>(`/meetings/${meetingId}/files/${fileId}/retry`, {
    method: 'POST',
    headers: authHeaders(token),
  });
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
  options: UploadOptions = {},
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<MeetingFile> {
  const body = new FormData();
  body.append('file', file, file.name);

  return sendWithProgress<MeetingFile>(
    { method: 'POST', path: `/meetings/${meetingId}/files`, token, body },
    options,
    createXhr,
  );
}

/**
 * The `XMLHttpRequest` half of this module, shared by the single-request upload and by each
 * chunk of a chunked one. Same contract as `apiFetch` — the API's own message in an
 * `ApiError`, `buildApiUrl` for the URL, the token as a bearer header — plus the two things
 * `fetch` cannot do: report upload progress and be aborted mid-body.
 */
function sendWithProgress<T>(
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

/** The chunked upload's five calls, in the order a client makes them. */
const uploadsPath = (meetingId: string): string => `/meetings/${meetingId}/files/uploads`;
const uploadPath = (meetingId: string, uploadId: string): string =>
  `${uploadsPath(meetingId)}/${uploadId}`;

/**
 * Opens a session for a file too large for one request. The server answers with the chunk
 * plan — size and count — which the client obeys rather than chooses.
 *
 * A 413 means the file is over the chunked cap, a 409 that the meeting is full.
 */
export function createUpload(
  token: string,
  meetingId: string,
  file: Pick<File, 'name' | 'size'>,
): Promise<MeetingFileUpload> {
  return apiFetch<MeetingFileUpload>(uploadsPath(meetingId), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name: file.name, size: file.size }),
  });
}

/**
 * The session as the server sees it, above all its `receivedChunks`. This is what makes a
 * resume cheap: the client sends only what is missing, and never asks the user to wait for
 * bytes the server already has. A 404 means the session expired, was aborted, or completed.
 */
export function getUpload(
  token: string,
  meetingId: string,
  uploadId: string,
): Promise<MeetingFileUpload> {
  return apiFetch<MeetingFileUpload>(uploadPath(meetingId, uploadId), {
    headers: authHeaders(token),
  });
}

/**
 * One chunk, as raw bytes. `XMLHttpRequest` for the same reason `uploadMeetingFile` is one:
 * per-chunk progress is what makes a percentage move on a long upload, and an `AbortSignal`
 * is what makes Cancel immediate rather than "after this chunk".
 *
 * The API answers 204, so this resolves to nothing.
 */
export function putChunk(
  token: string,
  meetingId: string,
  uploadId: string,
  index: number,
  chunk: Blob,
  options: UploadOptions = {},
  createXhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<void> {
  return sendWithProgress<void>(
    {
      method: 'PUT',
      path: `${uploadPath(meetingId, uploadId)}/chunks/${String(index)}`,
      token,
      body: chunk,
      contentType: 'application/octet-stream',
    },
    options,
    createXhr,
  );
}

/**
 * Assembles the session into a file. Safe to retry: a rejection here leaves every chunk on
 * the server, so a 415 or a dropped connection costs this call again, not the upload.
 */
export function completeUpload(
  token: string,
  meetingId: string,
  uploadId: string,
): Promise<MeetingFile> {
  return apiFetch<MeetingFile>(`${uploadPath(meetingId, uploadId)}/complete`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

/** Gives up on a session. A 404 means it was already gone — which is the same outcome. */
export function abortUpload(token: string, meetingId: string, uploadId: string): Promise<void> {
  return apiFetch<void>(uploadPath(meetingId, uploadId), {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}
