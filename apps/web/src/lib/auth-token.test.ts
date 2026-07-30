import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAccessToken, readAccessToken, storeAccessToken } from './auth-token';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the access token round trip', () => {
  it('reads back what it stored', () => {
    storeAccessToken('a-signed-jwt');

    expect(readAccessToken()).toBe('a-signed-jwt');
  });

  it('reports no token before one is stored', () => {
    expect(readAccessToken()).toBeNull();
  });

  it('forgets the token once cleared', () => {
    storeAccessToken('a-signed-jwt');
    clearAccessToken();

    expect(readAccessToken()).toBeNull();
  });
});

describe('when storage is unavailable', () => {
  it('does not throw on write — a finished registration must not fail over it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => {
      storeAccessToken('a-signed-jwt');
    }).not.toThrow();
  });

  it('reads as signed out rather than throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(readAccessToken()).toBeNull();
  });

  it('does not throw on clear', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(() => {
      clearAccessToken();
    }).not.toThrow();
  });
});
