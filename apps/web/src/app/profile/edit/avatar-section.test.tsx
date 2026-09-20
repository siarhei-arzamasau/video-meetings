import {
  AVATAR_SIZE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  MAX_AVATAR_SIZE_BYTES,
  type User,
} from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, deleteAvatar, fetchAvatar, uploadAvatar } from '@/lib/api-client';

import { AvatarSection } from './avatar-section';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
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
const UPLOADED: User = { ...WITHOUT_AVATAR, avatarPath: '/users/me/avatar', avatarVersion: 2 };
const REMOVED: User = { ...WITHOUT_AVATAR, avatarVersion: 2 };

const onSaved = vi.fn();
const onUnauthorized = vi.fn();

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

/** A `File` of a given type and size without allocating the bytes. */
function fileOf(type: string, size: number, name = 'ada.png'): File {
  const file = new File(['x'], name, { type });

  Object.defineProperty(file, 'size', { value: size });

  return file;
}

beforeEach(() => {
  let next = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:preview-${String(++next)}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

  vi.mocked(uploadAvatar).mockResolvedValue(UPLOADED);
  vi.mocked(deleteAvatar).mockResolvedValue(REMOVED);
  vi.mocked(fetchAvatar).mockResolvedValue(new Blob(['webp bytes']));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderSection(user: User = WITHOUT_AVATAR) {
  render(
    <AvatarSection
      user={user}
      token="a-signed-jwt"
      onSaved={onSaved}
      onUnauthorized={onUnauthorized}
    />,
  );

  return {
    user: userEvent.setup(),
    input: screen.getByLabelText('Choose a picture') as HTMLInputElement,
  };
}

describe('choosing a file', () => {
  it('opens the file dialog from the visible button', async () => {
    // The input is `aria-hidden` and out of the tab order, so this button is the only way a
    // user reaches the dialog at all. Every other test here drives the input directly, which
    // means nothing else would notice if the ref or the handler went away.
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});

    try {
      const form = renderSection();

      await form.user.click(screen.getByRole('button', { name: 'Choose a picture' }));

      expect(click).toHaveBeenCalledTimes(1);
      expect(click.mock.instances[0]).toBe(form.input);
    } finally {
      click.mockRestore();
    }
  });

  it('previews it and offers to upload, without sending anything yet', async () => {
    const form = renderSection();

    await form.user.upload(form.input, fileOf('image/png', 1_024));

    expect(await screen.findByRole('button', { name: 'Upload' })).toBeDefined();
    expect(screen.getByText('ada.png')).toBeDefined();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it.each([
    ['a type the contract does not take', fileOf('application/pdf', 1_024), AVATAR_TYPE_MESSAGE],
    ['a file over the cap', fileOf('image/png', MAX_AVATAR_SIZE_BYTES + 1), AVATAR_SIZE_MESSAGE],
  ])('refuses %s before any upload', async (_description, file, message) => {
    const form = renderSection();

    await form.user.upload(form.input, file);

    expect(await screen.findByText(message)).toBeDefined();
    // Refused where it was chosen, not after it has been sent: the point of checking in the
    // browser at all.
    expect(uploadAvatar).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('offers no Remove control while a replacement is waiting to be uploaded', async () => {
    const form = renderSection(WITH_AVATAR);

    expect(screen.getByRole('button', { name: 'Remove picture' })).toBeDefined();

    await form.user.upload(form.input, fileOf('image/png', 1_024));

    // Two destructive-looking choices at once would make the reader decide which one the
    // preview belongs to.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove picture' })).toBeNull();
    });
  });
});

describe('uploading', () => {
  it('sends the chosen file and hands the updated user back', async () => {
    const form = renderSection();
    const file = fileOf('image/png', 1_024);

    await form.user.upload(form.input, file);
    await form.user.click(await screen.findByRole('button', { name: 'Upload' }));

    await waitFor(() => {
      expect(uploadAvatar).toHaveBeenCalledWith('a-signed-jwt', file);
    });
    // The one call that makes the profile and the header change without a reload: the record
    // carries a new `avatarVersion`, and every `UserAvatar` keyed on it re-fetches.
    expect(onSaved).toHaveBeenCalledWith(UPLOADED);
  });

  it('confirms it and clears the preview', async () => {
    const form = renderSection();

    await form.user.upload(form.input, fileOf('image/png', 1_024));
    await form.user.click(await screen.findByRole('button', { name: 'Upload' }));

    expect(await screen.findByText('Your picture is saved.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('shows what the API says about an image it could not decode', async () => {
    vi.mocked(uploadAvatar).mockRejectedValue(new ApiError(400, 'That image could not be read.'));

    const form = renderSection();

    await form.user.upload(form.input, fileOf('image/png', 1_024));
    await form.user.click(await screen.findByRole('button', { name: 'Upload' }));

    // The browser cannot look inside the file, so this sentence is the server's and has to
    // reach the user unchanged.
    expect(await screen.findByText('That image could not be read.')).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('reports an unreachable API in words rather than as a thrown value', async () => {
    vi.mocked(uploadAvatar).mockRejectedValue(new TypeError('Failed to fetch'));

    const form = renderSection();

    await form.user.upload(form.input, fileOf('image/png', 1_024));
    await form.user.click(await screen.findByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(/We could not reach the server/)).toBeDefined();
  });

  it('signs the user out on a 401', async () => {
    vi.mocked(uploadAvatar).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const form = renderSection();

    await form.user.upload(form.input, fileOf('image/png', 1_024));
    await form.user.click(await screen.findByRole('button', { name: 'Upload' }));

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('removing', () => {
  it('is offered only to an account that has a picture', () => {
    renderSection(WITHOUT_AVATAR);

    expect(screen.queryByRole('button', { name: 'Remove picture' })).toBeNull();
  });

  it('removes it and hands the updated user back', async () => {
    const form = renderSection(WITH_AVATAR);

    await form.user.click(screen.getByRole('button', { name: 'Remove picture' }));

    await waitFor(() => {
      expect(deleteAvatar).toHaveBeenCalledWith('a-signed-jwt');
    });
    expect(onSaved).toHaveBeenCalledWith(REMOVED);
    expect(await screen.findByText('Your picture is removed.')).toBeDefined();
  });

  it('signs the user out on a 401', async () => {
    vi.mocked(deleteAvatar).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    const form = renderSection(WITH_AVATAR);

    await form.user.click(screen.getByRole('button', { name: 'Remove picture' }));

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
  });
});

describe('what the section says', () => {
  it('states the types and the cap, from the shared constants', () => {
    renderSection();

    expect(screen.getByText(/PNG, JPEG, or WebP, up to 5 MB/)).toBeDefined();
  });

  it('shows the current picture beside the chooser', async () => {
    renderSection(WITH_AVATAR);

    await waitFor(() => {
      expect(fetchAvatar).toHaveBeenCalledWith('a-signed-jwt');
    });
  });
});
