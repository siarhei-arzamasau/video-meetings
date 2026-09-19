import { expect, test } from '@playwright/test';

import { createMeetingViaApi, signUp } from './fixtures';

/**
 * The meeting page shell: reachable from the home page's cards, gated like `/`, showing the
 * header the PRD lists, and carrying an empty Files section with its call to action.
 */
test.describe('the meeting page', () => {
  test('is reached from a home page card and shows the header for its host', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const participant = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [participant.userId],
    });
    const { page } = host;

    await page.goto('/');
    await page.getByRole('link', { name: /Engine review/ }).click();

    await expect(page).toHaveURL(`/meetings/${meeting.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Engine review' })).toBeVisible();
    await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
    await expect(page.locator('time')).toHaveAttribute('datetime', meeting.scheduledAt);
    await expect(page.getByText('Hosted by you')).toBeVisible();
    await expect(page.getByText('1 participant', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to your meetings' })).toHaveAttribute(
      'href',
      '/',
    );

    await participant.context.close();
    await host.context.close();
  });

  test('tells a participant the meeting is hosted by another member', async ({ browser }) => {
    const host = await signUp(browser);
    const participant = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [participant.userId],
    });

    await participant.page.goto(`/meetings/${meeting.id}`);

    await expect(
      participant.page.getByRole('heading', { level: 1, name: 'Engine review' }),
    ).toBeVisible();
    await expect(participant.page.getByText('Hosted by another member')).toBeVisible();

    await participant.context.close();
    await host.context.close();
  });

  test('shows the not-found page to a signed-in user who is not on the meeting', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const stranger = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Private planning' });

    await stranger.page.goto(`/meetings/${meeting.id}`);

    await expect(stranger.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(stranger.page.getByText('Private planning')).toHaveCount(0);

    await stranger.context.close();
    await host.context.close();
  });

  test('redirects a signed-out visitor to sign in', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`/meetings/${meeting.id}`);

    await expect(page).toHaveURL(/\/auth\/login/);

    await context.close();
    await host.context.close();
  });

  test('shows an empty Files section with the call to action', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });

    await host.page.goto(`/meetings/${meeting.id}`);

    await expect(host.page.getByRole('heading', { level: 2, name: 'Files' })).toBeVisible();
    await expect(
      host.page.getByText('No files yet. Add an agenda, a deck, or a recording.'),
    ).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Add file' })).toBeVisible();

    await host.context.close();
  });
});
