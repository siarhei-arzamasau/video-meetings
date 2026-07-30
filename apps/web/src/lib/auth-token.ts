const STORAGE_KEY = 'video-meetings.access-token';

/**
 * Where the JWT lives between page loads.
 *
 * `localStorage` is the placeholder, not the answer. It is readable by any script the page
 * runs, so a single XSS hole hands over the token; the eventual fix is for the API to set an
 * `HttpOnly` cookie, at which point this module goes away rather than growing. It is here
 * because registration has to leave the user signed in somehow, and inventing a session layer
 * ahead of a login page would be the larger mistake.
 *
 * Every access is guarded: `localStorage` is absent during server rendering, and reading it
 * throws outright in a browser where storage is disabled or the quota is exhausted. Losing the
 * token is survivable — the user signs in again — so nothing here rethrows.
 */
export function storeAccessToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable: the session lasts as long as the tab, which is not worth failing a
    // completed registration over.
  }
}

export function readAccessToken(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearAccessToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — if it cannot be read either, it is already unreachable.
  }
}
