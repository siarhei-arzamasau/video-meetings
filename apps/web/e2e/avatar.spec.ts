import { expect, test } from '@playwright/test';

import {
  AVATAR_SIZE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  SAMPLE_PDF,
  SAMPLE_PNG,
  oversizedPng,
  setDisplayNameViaApi,
  signUp,
} from './fixtures';

/**
 * The avatar, in the browser.
 *
 * The claim worth a real browser is the one no unit test can make: after an upload, a page
 * that was never told about it — the home header — draws the new picture, and **no reload
 * happens anywhere in the test**. The initials fallback is asserted in both places for the
 * same reason.
 */
test.describe('the avatar', () => {
  test('is uploaded, seen in both places, and removed, without a reload', async ({ browser }) => {
    const user = await signUp(browser);
    await setDisplayNameViaApi(user.token, 'Ada Lovelace');
    const { page } = user;

    await page.goto('/profile');

    // Initials first: this account has no picture yet, and this is the fallback the phase has
    // to keep working.
    await expect(page.getByText('AL', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Edit profile' }).click();
    await page.getByLabel('Choose a picture').setInputFiles(SAMPLE_PNG);
    await page.getByRole('button', { name: 'Upload' }).click();

    await expect(page.getByText('Your picture is saved.')).toBeVisible();

    // On the profile, large.
    await page.getByRole('link', { name: 'Back to your profile' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
    await expect(page.locator('main img[src^="blob:"]')).toBeVisible();
    await expect(page.getByText('AL', { exact: true })).toBeHidden();

    // And in the header of a page that was never told the picture changed.
    await page.getByRole('link', { name: 'Back to your meetings' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Welcome back, Ada Lovelace' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Your profile/ }).locator('img')).toBeVisible();

    // Removing it puts the initials back in both places.
    await page.getByRole('link', { name: /Your profile/ }).click();
    await page.getByRole('link', { name: 'Edit profile' }).click();
    await page.getByRole('button', { name: 'Remove picture' }).click();

    await expect(page.getByText('Your picture is removed.')).toBeVisible();

    await page.getByRole('link', { name: 'Back to your profile' }).click();
    await expect(page.getByText('AL', { exact: true })).toBeVisible();
    await expect(page.locator('main img[src^="blob:"]')).toBeHidden();

    await page.getByRole('link', { name: 'Back to your meetings' }).click();
    await expect(page.getByRole('link', { name: /Your profile/ })).toContainText('AL');

    await user.context.close();
  });

  test('refuses an over-size file without sending it', async ({ browser }) => {
    const user = await signUp(browser);
    const { page } = user;

    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/avatar')) {
        uploads.push(request.url());
      }
    });

    await page.goto('/profile/edit');
    await page.getByLabel('Choose a picture').setInputFiles(oversizedPng());

    await expect(page.getByText(AVATAR_SIZE_MESSAGE)).toBeVisible();
    // Five megabytes not sent, which is the whole reason the size is checked in the browser.
    expect(uploads).toEqual([]);
    await expect(page.getByRole('button', { name: 'Upload' })).toBeHidden();

    await user.context.close();
  });

  test('refuses a file that is not an image', async ({ browser }) => {
    const user = await signUp(browser);
    const { page } = user;

    await page.goto('/profile/edit');
    await page.getByLabel('Choose a picture').setInputFiles(SAMPLE_PDF);

    await expect(page.getByText(AVATAR_TYPE_MESSAGE)).toBeVisible();

    await user.context.close();
  });
});
