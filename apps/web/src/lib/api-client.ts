import type { ApiErrorResponse, AuthResponse, Credentials, HealthResponse } from '@repo/shared';

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
