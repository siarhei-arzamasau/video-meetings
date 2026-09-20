import { DISPLAY_NAME_MESSAGE, MAX_DISPLAY_NAME_LENGTH, type User } from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, updateDisplayName } from '@/lib/api-client';
import type { SignedIn } from '@/lib/use-signed-in';

import { EditProfilePage } from './edit-profile-page';

const signOut = vi.fn();
const updateUser = vi.fn();
let session: SignedIn = { state: 'loading' };

vi.mock('@/lib/use-signed-in', () => ({
  useSignedIn: () => ({ session, signOut, updateUser }),
}));

// Partial, so `ApiError` stays the real class: the page tells a 400 from a 401 with
// `instanceof`, and a mocked-out constructor would make every branch fall to the network case.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  updateDisplayName: vi.fn(),
}));

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  // No `avatarPath`: this user has no picture, so both pages draw initials.
  avatarVersion: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
};

const RENAMED: User = { ...USER, displayName: 'Grace Hopper' };

beforeEach(() => {
  vi.mocked(updateDisplayName).mockResolvedValue(RENAMED);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWith(state: SignedIn) {
  session = state;

  return render(<EditProfilePage />);
}

function renderReady() {
  return renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });
}

/** The field, the button, and a fresh `userEvent` session for one test. */
function form() {
  return {
    user: userEvent.setup(),
    field: screen.getByLabelText('Display name'),
    save: screen.getByRole('button', { name: /Save changes/ }),
  };
}

describe('the gate', () => {
  it('renders no form at all while Next navigates a signed-out visitor away', () => {
    renderWith({ state: 'signedOut' });

    expect(screen.getByText('Taking you to sign in…')).toBeDefined();
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('names the page while it loads, so an empty shell is not anonymous', () => {
    renderWith({ state: 'loading' });

    expect(screen.getByRole('heading', { level: 1, name: 'Edit your profile' })).toBeDefined();
    expect(screen.getByText('Loading your profile')).toBeDefined();
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('offers the failure back to the user to retry', async () => {
    const retry = vi.fn();
    renderWith({ state: 'failed', message: 'The server is unreachable.', retry });

    expect(screen.getByText('The server is unreachable.')).toBeDefined();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('the display name section', () => {
  it('starts on the stored name, with nothing to save', () => {
    renderReady();
    const { field, save } = form();

    // Seeded, so the user edits the name they have rather than retyping it.
    expect((field as HTMLInputElement).value).toBe('Ada Lovelace');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Display name' })).toBeDefined();
    expect(screen.getByText(`Up to ${MAX_DISPLAY_NAME_LENGTH} characters.`)).toBeDefined();
  });

  it('has nothing to save for a name that differs only in padding', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, '  Ada Lovelace  ');

    // The API trims, so those two names are the same name and the request would change nothing.
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('offers the save once the name actually differs', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');

    expect(save.hasAttribute('disabled')).toBe(false);
  });
});

describe('validation before the request', () => {
  it('refuses a whitespace-only name without sending anything', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, '   ');
    await user.click(save);

    expect(await screen.findByText(DISPLAY_NAME_MESSAGE)).toBeDefined();
    // The client-side check only saves a round trip, so the thing worth pinning is that the
    // round trip really is saved.
    expect(updateDisplayName).not.toHaveBeenCalled();
  });

  it('refuses a name past the maximum without sending anything', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1));
    await user.click(save);

    expect(await screen.findByText(DISPLAY_NAME_MESSAGE)).toBeDefined();
    expect(updateDisplayName).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  it('sends the name as typed and hands the answer back to the gate', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');
    await user.click(save);

    await waitFor(() => {
      expect(updateDisplayName).toHaveBeenCalledWith('a-signed-jwt', 'Grace Hopper');
    });

    // The stored user is replaced with the API's answer, not with what was keyed — so the
    // header and the profile show the trimmed name the server actually kept.
    expect(updateUser).toHaveBeenCalledWith(RENAMED);
    expect(await screen.findByText('Your display name is saved.')).toBeDefined();
  });

  it('drops the confirmation as soon as the field says something else', async () => {
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');
    await user.click(save);
    expect(await screen.findByText('Your display name is saved.')).toBeDefined();

    await user.type(field, '!');

    // The sentence describes the stored name; the moment the field differs it is describing
    // something that is no longer on screen.
    await waitFor(() => {
      expect(screen.queryByText('Your display name is saved.')).toBeNull();
    });
  });
});

describe('a rejected save', () => {
  it('puts a 400 under the field, where the name the user must change is', async () => {
    vi.mocked(updateDisplayName).mockRejectedValue(new ApiError(400, DISPLAY_NAME_MESSAGE));
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    // Long enough to pass the client's own check, so the request is really made and the
    // answer is really the API's.
    await user.type(field, 'Grace Hopper');
    await user.click(save);

    expect(await screen.findByText(DISPLAY_NAME_MESSAGE)).toBeDefined();
    expect(screen.queryByText('We could not save your display name')).toBeNull();
  });

  it('signs the user out when the token went bad between the load and the save', async () => {
    vi.mocked(updateDisplayName).mockRejectedValue(new ApiError(401, 'Unauthorized'));
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');
    await user.click(save);

    await waitFor(() => {
      expect(signOut).toHaveBeenCalledOnce();
    });

    // Nest's bare "Unauthorized" tells a reader nothing, and the page is navigating away.
    expect(screen.queryByText('Unauthorized')).toBeNull();
  });

  it('puts a 500 above the form, because it says nothing about the name', async () => {
    vi.mocked(updateDisplayName).mockRejectedValue(new ApiError(500, 'Internal server error'));
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');
    await user.click(save);

    expect(await screen.findByText('Internal server error')).toBeDefined();
    expect(screen.getByText('We could not save your display name')).toBeDefined();
  });

  it('explains an unreachable API in its own words', async () => {
    // `fetch` rejects rather than resolving when the request never reached the API at all.
    vi.mocked(updateDisplayName).mockRejectedValue(new TypeError('Failed to fetch'));
    renderReady();
    const { user, field, save } = form();

    await user.clear(field);
    await user.type(field, 'Grace Hopper');
    await user.click(save);

    expect(
      await screen.findByText(
        'We could not reach the server. Check your connection and try again.',
      ),
    ).toBeDefined();
  });
});
