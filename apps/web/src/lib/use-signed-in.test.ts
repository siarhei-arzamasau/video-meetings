import type { User } from '@repo/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, getMe } from './api-client';
import type * as ApiClient from './api-client';
import { clearAccessToken, readAccessToken } from './auth-token';
import { useSignedIn } from './use-signed-in';

// One router for the whole file: the hook's effect depends on it, and a fresh object on every
// render would re-run the load on every render.
const router = { replace: vi.fn() };

vi.mock('next/navigation', () => ({ useRouter: () => router }));

// Partial, so `ApiError` stays the real class the hook tells a 401 apart with.
vi.mock('./api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  getMe: vi.fn(),
}));

vi.mock('./auth-token', () => ({
  readAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
}));

const TOKEN = 'header.payload.signature';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarVersion: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
};

/** Stands in until the promise below is constructed, which replaces it synchronously. */
const unset = (): void => undefined;

/** A promise the test settles by hand, for the cases about what arrives when. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve: (value: T) => void = unset;
  let reject: (error: unknown) => void = unset;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(readAccessToken).mockReturnValue(TOKEN);
  vi.mocked(getMe).mockResolvedValue(USER);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSignedIn', () => {
  it('sends a visitor with no token to sign in without asking the API', () => {
    vi.mocked(readAccessToken).mockReturnValue(null);

    const { result } = renderHook(() => useSignedIn());

    expect(result.current.session).toEqual({ state: 'signedOut' });
    expect(router.replace).toHaveBeenCalledWith('/auth/login');
    expect(getMe).not.toHaveBeenCalled();
  });

  it('loads the account behind a stored token', async () => {
    const { result } = renderHook(() => useSignedIn());

    expect(result.current.session).toEqual({ state: 'loading' });
    await waitFor(() => {
      expect(result.current.session).toEqual({ state: 'ready', user: USER, token: TOKEN });
    });
    expect(getMe).toHaveBeenCalledWith(TOKEN);
  });

  it('clears a token the API rejects and replaces the route with sign-in', async () => {
    vi.mocked(getMe).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const { result } = renderHook(() => useSignedIn());

    await waitFor(() => {
      expect(result.current.session).toEqual({ state: 'signedOut' });
    });
    expect(clearAccessToken).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/auth/login');
  });

  it('offers any other failure back, and a retry loads again', async () => {
    vi.mocked(getMe)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(USER);

    const { result } = renderHook(() => useSignedIn());

    await waitFor(() => {
      expect(result.current.session).toMatchObject({
        state: 'failed',
        message: 'We could not reach the server. Check your connection and try again.',
      });
    });
    expect(clearAccessToken).not.toHaveBeenCalled();

    const { session } = result.current;
    act(() => {
      if (session.state === 'failed') {
        session.retry();
      }
    });

    await waitFor(() => {
      expect(result.current.session).toEqual({ state: 'ready', user: USER, token: TOKEN });
    });
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it('ignores a response that lands after the page has gone', async () => {
    const pending = deferred<User>();
    vi.mocked(getMe).mockReturnValue(pending.promise);

    const { unmount } = renderHook(() => useSignedIn());
    unmount();
    pending.reject(new ApiError(401, 'Unauthorized'));
    await Promise.resolve();

    // A late 401 from a page that is gone must not sign out the page the user is now on.
    expect(clearAccessToken).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('signs out locally: clears the token and replaces the route', async () => {
    const { result } = renderHook(() => useSignedIn());
    await waitFor(() => {
      expect(result.current.session.state).toBe('ready');
    });

    act(() => {
      result.current.signOut();
    });

    expect(result.current.session).toEqual({ state: 'signedOut' });
    expect(clearAccessToken).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith('/auth/login');
  });

  it('does not put a user back on a page that signed out while the load was in flight', async () => {
    const pending = deferred<User>();
    vi.mocked(getMe).mockReturnValue(pending.promise);

    const { result } = renderHook(() => useSignedIn());
    act(() => {
      result.current.signOut();
    });
    await act(async () => {
      pending.resolve(USER);
      await pending.promise;
    });

    expect(result.current.session).toEqual({ state: 'signedOut' });
  });

  it('replaces the user of a ready session, and of no other', async () => {
    const renamed: User = { ...USER, displayName: 'Countess of Lovelace' };
    const pending = deferred<User>();
    vi.mocked(getMe).mockReturnValue(pending.promise);

    const { result } = renderHook(() => useSignedIn());
    act(() => {
      result.current.updateUser(renamed);
    });
    expect(result.current.session).toEqual({ state: 'loading' });

    await act(async () => {
      pending.resolve(USER);
      await pending.promise;
    });
    act(() => {
      result.current.updateUser(renamed);
    });

    expect(result.current.session).toEqual({ state: 'ready', user: renamed, token: TOKEN });
  });
});
