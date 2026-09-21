import type { Meeting } from '@repo/shared';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, countMeetings, listMeetings } from '@/lib/api-client';
import type * as ApiClient from '@/lib/api-client';

import { useDashboardMeetings } from './use-dashboard-meetings';

// Partial, so `ApiError` stays the class the hook tells a 401 apart with.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  listMeetings: vi.fn(),
  countMeetings: vi.fn(),
}));

const TOKEN = 'header.payload.signature';

const LATEST: ReadonlyArray<Meeting> = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Engine review',
    status: 'scheduled',
    hostId: '11111111-1111-4111-8111-111111111111',
    scheduledAt: '2026-10-01T09:00:00.000Z',
    participantIds: [],
  },
];

const onUnauthorized = vi.fn();

beforeEach(() => {
  vi.mocked(listMeetings).mockResolvedValue(LATEST);
  vi.mocked(countMeetings).mockResolvedValue(12);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useDashboardMeetings', () => {
  it('asks for the latest three and the total together, never the whole list', async () => {
    const { result } = renderHook(() => useDashboardMeetings(TOKEN, onUnauthorized));

    await waitFor(() => {
      expect(result.current.meetings).toEqual({ state: 'ready', latest: LATEST, total: 12 });
    });
    expect(listMeetings).toHaveBeenCalledWith(TOKEN, { order: 'desc', limit: 3 });
    expect(countMeetings).toHaveBeenCalledWith(TOKEN);
  });

  it('asks nothing until there is a token', () => {
    const { result } = renderHook(() => useDashboardMeetings(null, onUnauthorized));

    expect(result.current.meetings).toEqual({ state: 'loading' });
    expect(listMeetings).not.toHaveBeenCalled();
    expect(countMeetings).not.toHaveBeenCalled();
  });

  it('hands a 401 from either request to the gate', async () => {
    vi.mocked(countMeetings).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    renderHook(() => useDashboardMeetings(TOKEN, onUnauthorized));

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
  });

  it('offers any other failure back, and a retry asks again', async () => {
    vi.mocked(listMeetings)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(LATEST);

    const { result } = renderHook(() => useDashboardMeetings(TOKEN, onUnauthorized));

    await waitFor(() => {
      expect(result.current.meetings).toEqual({
        state: 'failed',
        message: 'We could not reach the server. Check your connection and try again.',
      });
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.meetings).toEqual({ state: 'ready', latest: LATEST, total: 12 });
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
