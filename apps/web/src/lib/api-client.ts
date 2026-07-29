import type { HealthResponse } from '@repo/shared';

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
    throw new ApiError(
      response.status,
      `Request to ${path} failed with ${String(response.status)}`,
    );
  }

  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health');
}
