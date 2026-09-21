'use client';

import type { User } from '@repo/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ApiError, getMe } from './api-client';
import { clearAccessToken, readAccessToken } from './auth-token';

/**
 * `loading` covers both "is there a token?" and "who is it?": they differ in the effect's
 * control flow, not on screen. It carries the token from the moment the effect has read it, so
 * a page can send its own requests beside `getMe` instead of after it — one round trip less on
 * every protected page — while still rendering nothing of their data until `ready`.
 * `signedOut` is its own state because the page stays mounted while Next navigates away, and in
 * that window it must render neither the user nor a spinner captioned with their data.
 */
export type SignedIn =
  | { state: 'loading'; token?: string }
  | { state: 'signedOut' }
  | { state: 'ready'; user: User; token: string }
  | { state: 'failed'; message: string; retry(): void };

/**
 * The client-side gate every protected page shares: the token read after mount, `getMe`, and
 * a 401 that clears the token and replaces the route with `/auth/login`.
 *
 * This is the code the `HttpOnly` cookie migration deletes, and it is deliberately not a
 * provider: no context, no refresh, no interceptor. It was lifted out of the home page when
 * the meeting page became the second protected route, unchanged in behaviour — reading the
 * token in an effect and never during render, because `localStorage` does not exist while
 * Next renders on the server, and a token-dependent first render would be a value the server
 * could not have produced.
 *
 * `signOut` is local: clear the token and replace to sign-in. The JWT is stateless and there
 * is no logout endpoint to call.
 *
 * `updateUser` is the one way the user held here changes after it is loaded, and it exists
 * for the edit page: `PATCH /users/me` answers with the whole updated record, so the page
 * that saved a new name puts it back here instead of refetching. It is **not** a shared
 * store — each page mounts its own copy of this hook — and nothing about that needs fixing:
 * every page loads the user at mount, so a page navigated to after a save reads the new value
 * from the API for itself.
 */
export function useSignedIn(): {
  session: SignedIn;
  signOut(): void;
  updateUser(user: User): void;
} {
  const router = useRouter();
  const [session, setSession] = useState<SignedIn>({ state: 'loading' });
  // Bumped by "Try again". The effect owns the whole load, so a retry re-runs it rather than
  // growing a second copy of the request logic inside a handler.
  const [reloadCount, setReloadCount] = useState(0);

  const signOut = useCallback((): void => {
    // Cleared first: a token the API has rejected — or one the user is done with — is worth
    // nothing, and leaving it behind costs the next visit a round trip to learn the same.
    clearAccessToken();
    setSession({ state: 'signedOut' });
    router.replace('/auth/login');
  }, [router]);

  // Updater form, and only over a `ready` session: a save that resolves after the token went
  // bad must not put a signed-out page back on screen holding a user.
  const updateUser = useCallback((user: User): void => {
    setSession((current) => (current.state === 'ready' ? { ...current, user } : current));
  }, []);

  useEffect(() => {
    const token = readAccessToken();

    if (token === null) {
      setSession({ state: 'signedOut' });
      router.replace('/auth/login');

      return;
    }

    // Handed out now rather than with the user, so a page's own requests need not wait on
    // `getMe`. Updater form, like every write here: only over a session that is still loading.
    setSession((current) => (current.state === 'loading' ? { state: 'loading', token } : current));

    // Ignores a response from a torn-down run. Strict Mode invokes this effect twice in
    // development, and "Try again" starts a second run while the first may still be in
    // flight; either way the older response must not land on the newer state.
    let active = true;

    async function load(bearer: string) {
      try {
        const user = await getMe(bearer);

        if (!active) {
          return;
        }

        // Updater form, so a load that resolves after the user pressed Log out cannot put
        // the page back on screen mid-navigation.
        setSession((current) =>
          current.state === 'loading' ? { state: 'ready', user, token: bearer } : current,
        );
      } catch (error) {
        if (!active) {
          return;
        }

        if (error instanceof ApiError && error.status === 401) {
          signOut();

          return;
        }

        setSession((current) =>
          current.state === 'loading'
            ? {
                state: 'failed',
                message: describeFailure(error),
                retry: () => {
                  setSession({ state: 'loading' });
                  setReloadCount((count) => count + 1);
                },
              }
            : current,
        );
      }
    }

    void load(token);

    return () => {
      active = false;
    };
    // `router` and `signOut` are stable across renders, so they do not re-run this.
  }, [router, signOut, reloadCount]);

  return { session, signOut, updateUser };
}

/**
 * Turns a thrown value into something to show.
 *
 * A 401 never reaches this — that branch clears the token and redirects — which is what makes
 * rendering the message safe: a 401's `ApiError.message` is Nest's bare "Unauthorized", which
 * tells a reader nothing.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  // `fetch` rejects rather than resolving when the request never reached the API at all.
  return 'We could not reach the server. Check your connection and try again.';
}
