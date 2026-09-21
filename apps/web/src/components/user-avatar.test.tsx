import type { User } from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, fetchAvatar } from '@/lib/api-client';

import { UserAvatar } from './user-avatar';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  fetchAvatar: vi.fn(),
}));

const WITHOUT_AVATAR: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  avatarVersion: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
};

const WITH_AVATAR: User = { ...WITHOUT_AVATAR, avatarPath: '/users/me/avatar', avatarVersion: 1 };

/** jsdom implements neither, and the component's whole job is turning a blob into an `<img>`.
 *  Counting the calls is also how "revoked exactly once, and after the swap" is asserted. */
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  let next = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:avatar-${String(++next)}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  vi.mocked(fetchAvatar).mockResolvedValue(new Blob(['webp bytes']));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The rendered `<img>`, or `null` when the component fell back to initials. */
function image(): HTMLImageElement | null {
  return document.querySelector('img');
}

describe('an account with no picture', () => {
  it('draws the initials instead, and asks for nothing', () => {
    render(<UserAvatar token="a-signed-jwt" user={WITHOUT_AVATAR} />);

    expect(screen.getByText('AL')).toBeDefined();
    expect(image()).toBeNull();
    expect(fetchAvatar).not.toHaveBeenCalled();
  });
});

describe('an account with a picture', () => {
  it('fetches it with the token and renders it from a blob', async () => {
    render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(image()).not.toBeNull();
    });
    expect(fetchAvatar).toHaveBeenCalledWith('a-signed-jwt');
    expect(image()?.getAttribute('src')).toBe('blob:avatar-1');
    // Decorative: the name is rendered beside it at both call sites, so announcing the
    // picture would read the same person twice.
    expect(image()?.getAttribute('alt')).toBe('');
    expect(image()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to initials when the fetch fails', async () => {
    vi.mocked(fetchAvatar).mockRejectedValue(new ApiError(404, 'No avatar'));

    render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(fetchAvatar).toHaveBeenCalled();
    });
    // A missing picture is a cosmetic loss. The circle is never empty and never an error.
    expect(screen.getByText('AL')).toBeDefined();
    expect(image()).toBeNull();
  });
});

describe('when the picture changes', () => {
  it('re-fetches on a new version, although the path is the same', async () => {
    const { rerender } = render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(image()?.getAttribute('src')).toBe('blob:avatar-1');
    });

    rerender(<UserAvatar token="a-signed-jwt" user={{ ...WITH_AVATAR, avatarVersion: 2 }} />);

    // The whole reason the API sends a version: nothing about the URL changed, so a fetch
    // keyed on the path alone would keep showing the picture that was replaced.
    await waitFor(() => {
      expect(image()?.getAttribute('src')).toBe('blob:avatar-2');
    });
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it('does not re-fetch on an unrelated change to the user', async () => {
    const { rerender } = render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(fetchAvatar).toHaveBeenCalledTimes(1);
    });

    rerender(<UserAvatar token="a-signed-jwt" user={{ ...WITH_AVATAR, displayName: 'Grace' }} />);

    expect(fetchAvatar).toHaveBeenCalledTimes(1);
  });

  it('releases the old blob only once the new one is on screen', async () => {
    const { rerender } = render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(image()?.getAttribute('src')).toBe('blob:avatar-1');
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    rerender(<UserAvatar token="a-signed-jwt" user={{ ...WITH_AVATAR, avatarVersion: 2 }} />);

    await waitFor(() => {
      expect(image()?.getAttribute('src')).toBe('blob:avatar-2');
    });
    // Revoking when the replacement *starts* loading would free the picture on screen, and
    // the user would watch a broken image until the new one arrived.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:avatar-2');
  });

  it('draws initials again once the picture is removed', async () => {
    const { rerender } = render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(image()).not.toBeNull();
    });

    rerender(<UserAvatar token="a-signed-jwt" user={{ ...WITHOUT_AVATAR, avatarVersion: 2 }} />);

    await waitFor(() => {
      expect(screen.getByText('AL')).toBeDefined();
    });
    expect(image()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1');
  });

  it('releases the blob when it unmounts', async () => {
    const { unmount } = render(<UserAvatar token="a-signed-jwt" user={WITH_AVATAR} />);

    await waitFor(() => {
      expect(image()).not.toBeNull();
    });

    unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-1');
  });
});
