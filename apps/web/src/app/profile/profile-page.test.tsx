import type { User } from '@repo/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignedIn } from '@/lib/use-signed-in';

import { ProfilePage } from './profile-page';

const signOut = vi.fn();
const updateUser = vi.fn();
let session: SignedIn = { state: 'loading' };

vi.mock('@/lib/use-signed-in', () => ({
  useSignedIn: () => ({ session, signOut, updateUser }),
}));

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  // No `avatarPath`: this user has no picture, so both pages draw initials.
  avatarVersion: 0,
  createdAt: '2026-07-30T09:00:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWith(state: SignedIn) {
  session = state;

  return render(<ProfilePage />);
}

describe('the gate', () => {
  it('renders nothing about the user while Next navigates a signed-out visitor away', () => {
    renderWith({ state: 'signedOut' });

    expect(screen.getByText('Taking you to sign in…')).toBeDefined();
    // The page stays mounted during the redirect, and in that window it must show neither the
    // account nor a spinner captioned with it.
    expect(screen.queryByText(USER.email)).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('names the page while it loads, so an empty shell is not anonymous', () => {
    renderWith({ state: 'loading' });

    expect(screen.getByRole('heading', { level: 1, name: 'Your profile' })).toBeDefined();
    expect(screen.getByText('Loading your profile')).toBeDefined();
    expect(screen.queryByText(USER.email)).toBeNull();
  });

  it('offers the failure back to the user to retry', async () => {
    const retry = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    renderWith({ state: 'failed', message: 'The server is unreachable.', retry });

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('The server is unreachable.')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(retry).toHaveBeenCalledOnce();
  });

  it('disables Log out only while the gate is still loading', () => {
    renderWith({ state: 'loading' });
    expect(screen.getByRole('button', { name: /Log out/ }).hasAttribute('disabled')).toBe(true);

    cleanup();

    renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });
    expect(screen.getByRole('button', { name: /Log out/ }).hasAttribute('disabled')).toBe(false);
  });
});

describe('the account card', () => {
  it('shows every field the page exists to show', () => {
    const { container } = renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });

    expect(screen.getByText('Ada Lovelace')).toBeDefined();
    expect(screen.getByText('ada@example.com')).toBeDefined();
    // Read off the element rather than with `getByText`: the line is "Joined " plus a `time`,
    // so the prefix and the date are two text nodes and no single one of them matches.
    expect(container.querySelector('time')?.parentElement?.textContent).toMatch(/^Joined \S/);
  });

  it('keeps the exact instant in the markup while showing only the day', () => {
    const { container } = renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });
    const time = container.querySelector('time');

    expect(time?.getAttribute('datetime')).toBe(USER.createdAt);
    // The rendered text is the day alone: anything carrying a clock would be showing an
    // instant the reader never asked for, in whatever timezone the browser happens to be in.
    expect(time?.textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('stands the initials in for the avatar, hidden from a screen reader', () => {
    renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });

    const initials = screen.getByText('AL');

    // The name is rendered beside it, so announcing "A L" would read the same person twice.
    expect(initials.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to a placeholder rather than an empty circle', () => {
    renderWith({
      state: 'ready',
      user: { ...USER, displayName: '?' },
      token: 'a-signed-jwt',
    });

    expect(screen.getAllByText('?').length).toBeGreaterThan(0);
  });

  it('links to the edit page, as an anchor Next can route on', () => {
    renderWith({ state: 'ready', user: USER, token: 'a-signed-jwt' });

    expect(screen.getByRole('link', { name: 'Edit profile' }).getAttribute('href')).toBe(
      '/profile/edit',
    );
    expect(screen.getByRole('link', { name: /Back to your meetings/ }).getAttribute('href')).toBe(
      '/',
    );
  });
});
