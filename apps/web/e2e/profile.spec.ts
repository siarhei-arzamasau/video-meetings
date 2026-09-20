import { expect, test } from '@playwright/test';

import { setDisplayNameViaApi, signUp } from './fixtures';

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
