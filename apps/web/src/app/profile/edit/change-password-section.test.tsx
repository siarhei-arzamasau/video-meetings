import {
  CURRENT_PASSWORD_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '@/lib/api-client';
import { ApiError, changePassword } from '@/lib/api-client';
import { validatePassword } from '@/lib/credentials';

import { ChangePasswordSection } from './change-password-section';

// Partial, so `ApiError` stays the real class: the section tells a 400 from a 401 with
// `instanceof`, and a mocked-out constructor would send every branch to the network case.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  changePassword: vi.fn(),
}));

const CURRENT = 'old-password';
const NEW = 'a-new-password';

const onUnauthorized = vi.fn();

beforeEach(() => {
  vi.mocked(changePassword).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSection() {
  render(<ChangePasswordSection token="a-signed-jwt" onUnauthorized={onUnauthorized} />);

  return {
    user: userEvent.setup(),
    current: screen.getByLabelText('Current password'),
    next: screen.getByLabelText('New password'),
    confirmation: screen.getByLabelText('Confirm new password'),
    submit: screen.getByRole('button', { name: /Change password/ }),
  };
}

/** Fills all three fields and submits, which is the happy path every failing case varies. */
async function fillAndSubmit(
  values: { current?: string; next?: string; confirmation?: string } = {},
) {
  const form = renderSection();
  const { current = CURRENT, next = NEW, confirmation = next } = values;

  await form.user.type(form.current, current);
  await form.user.type(form.next, next);
  await form.user.type(form.confirmation, confirmation);
  await form.user.click(form.submit);

  return form;
}

describe('refusing a change before any request is sent', () => {
  it('sends nothing when the confirmation does not match', async () => {
    await fillAndSubmit({ confirmation: 'a-new-passwerd' });

    expect(await screen.findByText(PASSWORD_MISMATCH_MESSAGE)).toBeDefined();
    // The whole point of the confirmation: the API has nothing to compare it against, so a
    // round trip here would be one the server could not have answered usefully.
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('sends nothing when the new password is too short', async () => {
    await fillAndSubmit({ next: 'short' });

    // The exact sentence `validatePassword` returns, not a phrase: the field's own
    // description says "At least 8 characters" too, and matching loosely would pass on it.
    expect(await screen.findByText(String(validatePassword('short')))).toBeDefined();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('sends nothing when the new password repeats the current one', async () => {
    await fillAndSubmit({ next: CURRENT });

    expect(await screen.findByText(PASSWORD_UNCHANGED_MESSAGE)).toBeDefined();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('sends nothing when the current password is blank', async () => {
    const form = renderSection();

    await form.user.type(form.next, NEW);
    await form.user.type(form.confirmation, NEW);
    await form.user.click(form.submit);

    expect(changePassword).not.toHaveBeenCalled();
  });
});

describe('a successful change', () => {
  it('sends the two passwords and confirms in the form', async () => {
    await fillAndSubmit();

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledWith('a-signed-jwt', CURRENT, NEW);
    });
    expect(await screen.findByText(/Your password is changed/)).toBeDefined();
  });

  it('never sends the confirmation', async () => {
    await fillAndSubmit();

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalled();
    });
    // Three arguments, not four: the API would answer a confirmation with a 400, because
    // `forbidNonWhitelisted` rejects a field the DTO does not declare.
    expect(vi.mocked(changePassword).mock.calls[0]).toHaveLength(3);
  });

  it('clears all three fields, so neither password is left on screen', async () => {
    const form = await fillAndSubmit();

    await screen.findByText(/Your password is changed/);

    expect((form.current as HTMLInputElement).value).toBe('');
    expect((form.next as HTMLInputElement).value).toBe('');
    expect((form.confirmation as HTMLInputElement).value).toBe('');
  });

  it('retires the confirmation as soon as a field is edited again', async () => {
    const form = await fillAndSubmit();

    await screen.findByText(/Your password is changed/);
    await form.user.type(form.current, 'x');

    // The sentence describes a change that happened; the moment the form says something else,
    // it is describing state that is no longer on screen.
    await waitFor(() => {
      expect(screen.queryByText(/Your password is changed/)).toBeNull();
    });
  });
});

describe('a change the API refuses', () => {
  it('puts a wrong current password on the current-password field', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(401, CURRENT_PASSWORD_MESSAGE));

    await fillAndSubmit();

    expect(await screen.findByText(CURRENT_PASSWORD_MESSAGE)).toBeDefined();
    // The field, not the gate: a typo must not sign the user out of the app.
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('signs the user out for any other 401', async () => {
    // The guard's own 401: the token expired between the page load and this request.
    vi.mocked(changePassword).mockRejectedValue(new ApiError(401, 'Unauthorized'));

    await fillAndSubmit();

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
    expect(screen.queryByText('Unauthorized')).toBeNull();
  });

  it('puts a 400 on the new-password field', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(400, PASSWORD_UNCHANGED_MESSAGE));

    await fillAndSubmit();

    expect(await screen.findByText(PASSWORD_UNCHANGED_MESSAGE)).toBeDefined();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('puts a 500 above the form, where it belongs to the section', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(500, 'Internal server error'));

    await fillAndSubmit();

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('We could not change your password')).toBeDefined();
  });

  it('reports an unreachable API in words rather than as a thrown value', async () => {
    vi.mocked(changePassword).mockRejectedValue(new TypeError('Failed to fetch'));

    await fillAndSubmit();

    expect(await screen.findByText(/We could not reach the server/)).toBeDefined();
  });

  it('keeps what was typed after a rejection, so it can be corrected', async () => {
    vi.mocked(changePassword).mockRejectedValue(new ApiError(401, CURRENT_PASSWORD_MESSAGE));

    const form = await fillAndSubmit();

    await screen.findByText(CURRENT_PASSWORD_MESSAGE);

    expect((form.next as HTMLInputElement).value).toBe(NEW);
  });
});

describe('what the section says about other devices', () => {
  it('states that they stay signed in, without being asked', async () => {
    renderSection();

    // Visible before anything is typed: it is a consequence of the change the user cannot see
    // for themselves, and the mitigation the PRD agreed on for an unrevokable token.
    expect(
      await screen.findByText(/does not sign out your other devices/, { exact: false }),
    ).toBeDefined();
  });
});

describe('revealing what was typed', () => {
  it('shows and hides every password field with one control', async () => {
    const form = renderSection();

    expect((form.current as HTMLInputElement).type).toBe('password');

    await form.user.click(screen.getByRole('button', { name: 'Show passwords' }));

    expect((form.current as HTMLInputElement).type).toBe('text');
    expect((form.next as HTMLInputElement).type).toBe('text');
    expect((form.confirmation as HTMLInputElement).type).toBe('text');

    await form.user.click(screen.getByRole('button', { name: 'Hide passwords' }));

    expect((form.confirmation as HTMLInputElement).type).toBe('password');
  });
});
