import { expect, test } from '@playwright/test';

import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  setDisplayNameViaApi,
  signUp,
} from './fixtures';

/**
 * The profile page: reachable from the home page header, gated like every other protected
 * route, and showing the account the token names.
 */
test.describe('the profile page', () => {
  test('is reached from the home page header and shows the account', async ({ browser }) => {
    const user = await signUp(browser);
    await setDisplayNameViaApi(user.token, 'Ada Lovelace');
    const { page } = user;

    await page.goto('/');
    await page.getByRole('link', { name: /Your profile/ }).click();

    await expect(page).toHaveURL('/profile');
    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
    // The initials stand in for the avatar phase 6 adds, so they are part of the page now.
    await expect(page.getByText('AL', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Joined /)).toBeVisible();
    await expect(page.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    await expect(page.getByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/profile/edit',
    );
    await expect(page.getByRole('link', { name: 'Back to your meetings' })).toHaveAttribute(
      'href',
      '/',
    );

    await user.context.close();
  });

  test('redirects a signed-out visitor to sign in', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/profile');

    await expect(page).toHaveURL(/\/auth\/login/);

    await context.close();
  });
});

/**
 * The edit page, and the one section it has so far. The phases after this one add their own
 * sections to the same route rather than routes of their own.
 */
test.describe('the profile edit page', () => {
  test('saves a new display name, and the home greeting follows it on navigation', async ({
    browser,
  }) => {
    const user = await signUp(browser);
    await setDisplayNameViaApi(user.token, 'Ada Lovelace');
    const { page } = user;

    await page.goto('/profile');
    await page.getByRole('link', { name: 'Edit profile' }).click();

    await expect(page).toHaveURL('/profile/edit');
    await expect(page.getByRole('heading', { level: 1, name: 'Edit your profile' })).toBeVisible();

    // The field starts on the stored name, so the user edits what they have rather than
    // retyping it.
    const field = page.getByLabel('Display name');
    await expect(field).toHaveValue('Ada Lovelace');

    await field.fill('Grace Hopper');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByText('Your display name is saved.')).toBeVisible();

    await page.getByRole('link', { name: 'Back to your profile' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page.getByText('Grace Hopper')).toBeVisible();

    // The whole point of the phase: no reload anywhere in this test, and the greeting on a
    // page that was never told about the change is the new name.
    await page.getByRole('link', { name: 'Back to your meetings' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Welcome back, Grace Hopper' }),
    ).toBeVisible();

    await user.context.close();
  });

  test('refuses a name the API would reject, without sending a request', async ({ browser }) => {
    const user = await signUp(browser);
    const { page } = user;

    // The client-side check only saves a round trip, so the thing worth pinning is that the
    // round trip really is saved.
    const patched: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') {
        patched.push(request.url());
      }
    });

    await page.goto('/profile/edit');
    const field = page.getByLabel('Display name');
    await expect(field).not.toHaveValue('');

    const save = page.getByRole('button', { name: 'Save changes' });

    // Whitespace-only, then over-long: one message covers every way a name is refused, and it
    // is the sentence the API would have sent.
    await field.fill('   ');
    await save.click();
    await expect(page.getByText(DISPLAY_NAME_MESSAGE)).toBeVisible();

    await field.fill('a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1));
    await save.click();
    await expect(page.getByText(DISPLAY_NAME_MESSAGE)).toBeVisible();

    expect(patched).toEqual([]);

    await user.context.close();
  });

  test('saves nothing when the page is left with unsaved changes', async ({ browser }) => {
    const user = await signUp(browser);
    await setDisplayNameViaApi(user.token, 'Ada Lovelace');
    const { page } = user;

    await page.goto('/profile/edit');
    await expect(page.getByLabel('Display name')).toHaveValue('Ada Lovelace');

    await page.getByLabel('Display name').fill('Grace Hopper');
    await page.getByRole('link', { name: 'Back to your profile' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();

    await page.goto('/profile/edit');
    await expect(page.getByLabel('Display name')).toHaveValue('Ada Lovelace');

    await user.context.close();
  });

  test('redirects a signed-out visitor to sign in', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/profile/edit');

    await expect(page).toHaveURL(/\/auth\/login/);

    await context.close();
  });
});
