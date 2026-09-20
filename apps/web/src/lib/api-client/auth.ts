import type { AuthResponse, Credentials, HealthResponse, User } from '@repo/shared';

import { apiFetch, authHeaders } from './core';

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
