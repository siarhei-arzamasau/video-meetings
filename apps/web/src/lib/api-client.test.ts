import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, buildApiUrl, getApiBaseUrl } from './api-client';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getApiBaseUrl', () => {
  it('falls back to the local API when NEXT_PUBLIC_API_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);

    expect(getApiBaseUrl()).toBe('http://localhost:3001/api');
  });

  it('strips trailing slashes from the configured value', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api//');

    expect(getApiBaseUrl()).toBe('https://api.example.com/api');
  });
});

describe('buildApiUrl', () => {
  it('joins a leading-slash path onto the base URL', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');

    expect(buildApiUrl('/health')).toBe('https://api.example.com/api/health');
  });

  it('inserts the missing separator for a bare path', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');

    expect(buildApiUrl('health')).toBe('https://api.example.com/api/health');
  });
});

describe('ApiError', () => {
  it('carries the HTTP status alongside the message', () => {
    const error = new ApiError(503, 'Service unavailable');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(error.status).toBe(503);
  });
});
