import fs from 'node:fs';

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  SAMPLE_PNG,
  brokenPng,
  createMeetingViaApi,
  listMeetingFilesViaApi,
  objectPathOf,
  signUp,
} from './fixtures';

const rowFor = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

/** The chip labels are exact: "Processing failed" also contains "Processing". */
const processingChip = (row: Locator): Locator => row.getByText('Processing', { exact: true });
const failedChip = (row: Locator): Locator => row.getByText('Processing failed', { exact: true });

const BROKEN_NAME = 'broken.png';

/**
 * Uploads a PNG the preview step cannot read and waits for the row to say so. The bytes are
 * the same length as the real image, so writing the real ones over the object later repairs
 * the file instead of contradicting the record's size.
 */
async function uploadBrokenImage(page: Page): Promise<Locator> {
  await page.locator('input[type="file"]').setInputFiles({
    name: BROKEN_NAME,
    mimeType: 'image/png',
    buffer: brokenPng(),
  });

  const row = rowFor(page, BROKEN_NAME);
  await expect(failedChip(row)).toBeVisible({ timeout: 15_000 });

  return row;
}

test.describe('retrying a failed file', () => {
  test('sends the file back through the pipeline, and settles once the bytes are good', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    const row = await uploadBrokenImage(page);

    // The reason the worker stored, in the chip's tooltip. The pointer is nudged first: on a
    // fresh page Playwright's mouse jumps from its initial position straight onto the chip,
    // and React Aria does not count an arrival it never saw travel as a hover — a person has
    // always moved the mouse across the page before reaching the chip. Any movement suffices.
    await page.mouse.move(1, 1);
    await failedChip(row).hover();
    await expect(page.getByText('The image could not be read')).toBeVisible();

    // First retry: the bytes are still unreadable, so the row goes back to Processing and
    // comes back failed. That is what proves the file really re-ran the pipeline.
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(processingChip(row)).toBeVisible();
    await expect(failedChip(row)).toBeVisible({ timeout: 15_000 });

    // Repair the object, then retry again: no chip at all, and a thumbnail the preview step
    // could only have written from readable bytes.
    const [file] = await listMeetingFilesViaApi(host.token, meeting.id);
    expect(file?.name).toBe(BROKEN_NAME);
    fs.writeFileSync(objectPathOf(meeting.id, file?.id ?? ''), fs.readFileSync(SAMPLE_PNG));

    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(failedChip(row)).toBeHidden({ timeout: 15_000 });
    await expect(processingChip(row)).toBeHidden({ timeout: 15_000 });

    const image = row.locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    await host.context.close();
  });

  test('is reachable by keyboard from the chip', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    const row = await uploadBrokenImage(page);
    const retry = row.getByRole('button', { name: 'Retry' });

    // The warning chip is focusable so its tooltip can be read without a pointer; Retry is
    // the next stop, and Enter presses it.
    await row.locator('[tabindex="0"]').first().focus();
    await page.keyboard.press('Tab');
    await expect(retry).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(processingChip(row)).toBeVisible();

    await host.context.close();
  });

  test('offers no Retry to a participant who is neither the uploader nor the host', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const guest = await signUp(browser);
    const other = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [guest.userId, other.userId],
    });

    await guest.page.goto(`/meetings/${meeting.id}`);
    await uploadBrokenImage(guest.page);

    await other.page.goto(`/meetings/${meeting.id}`);
    const row = rowFor(other.page, BROKEN_NAME);
    await expect(failedChip(row)).toBeVisible({ timeout: 15_000 });
    // Someone else's failed file: they can still download it, but not retry or delete it.
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // The host may retry a participant's file, the same rule as Delete.
    await host.page.goto(`/meetings/${meeting.id}`);
    const hostRow = rowFor(host.page, BROKEN_NAME);
    await expect(hostRow.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 15_000 });

    await Promise.all([host.context.close(), guest.context.close(), other.context.close()]);
  });
});
