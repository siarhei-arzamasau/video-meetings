import { expect, test } from '@playwright/test';

import {
  CURRENT_PASSWORD_MESSAGE,
  PASSWORD,
  PASSWORD_MISMATCH_MESSAGE,
  signInThroughUi,
  signUp,
} from './fixtures';

const NEW_PASSWORD = 'a-different-battery-43';

/**
 * The password section on `/profile/edit`.
 *
 * The one flow worth a browser for is the round trip: change it here, sign out, and sign back
 * in with the new one. Nothing short of that proves the password really moved — the form's own
 * confirmation only says the request came back 204.
 */
test.describe('changing the password', () => {
  test('changes it, and the new one is what signs back in', async ({ browser }) => {
    const user = await signUp(browser);
    const { page } = user;

    await page.goto('/profile/edit');
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText(/Your password is changed/)).toBeVisible();
    // Neither password is left on screen afterwards.
    await expect(page.getByLabel('Current password')).toHaveValue('');
    await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);

    // The old one first, so the test would fail if the change had not taken.
    await signInThroughUi(page, user.email, PASSWORD);
    await expect(page.getByText(/Invalid email or password/)).toBeVisible();

    await signInThroughUi(page, user.email, NEW_PASSWORD);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1, name: /Welcome back/ })).toBeVisible();

    await user.context.close();
  });

  test('reports a wrong current password on that field, and stays signed in', async ({
    browser,
  }) => {
    const user = await signUp(browser);
    const { page } = user;

    await page.goto('/profile/edit');
    await page.getByLabel('Current password').fill('not-the-password');
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText(CURRENT_PASSWORD_MESSAGE)).toBeVisible();

    // The whole reason the API's 401 carries a distinct sentence: the browser reads an
    // ordinary 401 as "signed out", and a typo here must not redirect anyone to sign-in.
    await expect(page).toHaveURL('/profile/edit');
    await expect(page.getByRole('heading', { level: 1, name: 'Edit your profile' })).toBeVisible();

    // And the password really is untouched.
    await page.getByRole('button', { name: 'Log out' }).click();
    await signInThroughUi(page, user.email, PASSWORD);
    await expect(page).toHaveURL('/');

    await user.context.close();
  });

  test('refuses a mismatched confirmation without sending a request', async ({ browser }) => {
    const user = await signUp(browser);
    const { page } = user;

    const patched: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') {
        patched.push(request.url());
      }
    });

    await page.goto('/profile/edit');
    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill('a-different-battery-44');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByText(PASSWORD_MISMATCH_MESSAGE)).toBeVisible();
    // The API is never sent a confirmation, so there is nothing it could have said about this.
    expect(patched).toEqual([]);

    await user.context.close();
  });

  test('says next to the form that other devices stay signed in', async ({ browser }) => {
    const user = await signUp(browser);

    await user.page.goto('/profile/edit');

    await expect(user.page.getByText(/does not sign out your other devices/)).toBeVisible();

    await user.context.close();
  });
});
