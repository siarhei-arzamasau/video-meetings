import type {
  ApiErrorResponse,
  AuthResponse,
  Credentials,
  HealthResponse,
  Meeting,
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

/** The single boundary between the web app and the API. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response, path));
  }

  return (await response.json()) as T;
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
  const fallback = `Request to ${path} failed with ${String(response.status)}`;

  try {
    return extractMessage(await response.json()) ?? fallback;
  } catch {
    return fallback;
  }
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
