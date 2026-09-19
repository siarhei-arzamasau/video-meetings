import fs from 'node:fs';

import type { Locator, Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  NOTES_TXT,
  PAGE_HTML,
  SAMPLE_PDF,
  SAMPLE_PNG,
  createMeetingViaApi,
  oversizedFile,
  signUp,
} from './fixtures';

/** The row for a file, by name. Rows are list items inside the Files list. */
const rowFor = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

const isUploadRequest = (request: Request): boolean =>
  request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/files');

const pickFiles = (page: Page, files: string[]): Promise<void> =>
  page.locator('input[type="file"]').setInputFiles(files);

test.describe('the files section', () => {
  test('uploads a picked file, shows it processing, then settles once the worker is done', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    await pickFiles(page, [SAMPLE_PDF]);

    const row = rowFor(page, 'sample.pdf');
    await expect(row).toBeVisible();
    await expect(row.getByText('329 B')).toBeVisible();
    await expect(row.getByText('added by you')).toBeVisible();
    await expect(row.getByText('Processing')).toBeVisible();
    // The worker polls every 250 ms in this suite and the list refetches every 3 s.
    await expect(row.getByText('Processing')).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText('No files yet', { exact: false })).toHaveCount(0);

    await host.context.close();
  });

  test('renders a thumbnail for an image once processed', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    await pickFiles(page, [SAMPLE_PNG]);

    const row = rowFor(page, 'sample.png');
    await expect(row.getByText('Processing')).toBeHidden({ timeout: 10_000 });
    const image = row.locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    await host.context.close();
  });

  test('rejects an oversized file client-side without sending it, and Dismiss removes the row', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const uploads: Request[] = [];
    page.on('request', (request) => {
      if (isUploadRequest(request)) {
        uploads.push(request);
      }
    });
    await page.goto(`/meetings/${meeting.id}`);

    await pickFiles(page, [oversizedFile()]);

    const row = rowFor(page, 'meeting-files-e2e-oversized.bin');
    await expect(row.getByText('Files must be 100 MB or smaller.')).toBeVisible();
    expect(uploads).toHaveLength(0);

    await row.getByRole('button', { name: 'Dismiss' }).click();
    await expect(row).toHaveCount(0);
    expect(uploads).toHaveLength(0);

    await host.context.close();
  });

  test("shows the server's rejection inline for a renamed HTML file", async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    // Renamed on the way in: the extension passes the client check, the bytes fail the server's.
    await page.locator('input[type="file"]').setInputFiles({
      name: 'page.pdf',
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(PAGE_HTML),
    });

    const row = rowFor(page, 'page.pdf');
    await expect(row.getByText('That file type is not supported.')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Dismiss' })).toBeVisible();

    await host.context.close();
  });

  test('downloads the original bytes under the original name', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [NOTES_TXT]);
    const row = rowFor(page, 'notes.txt');
    await expect(row.getByText('Processing')).toBeHidden({ timeout: 10_000 });

    const downloadPromise = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('notes.txt');
    const saved = await download.path();
    expect(fs.readFileSync(saved).equals(fs.readFileSync(NOTES_TXT))).toBe(true);

    await host.context.close();
  });

  test('lets the uploader delete behind a confirm dialog naming the file', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [SAMPLE_PDF]);
    const row = rowFor(page, 'sample.pdf');
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Delete' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('Delete "sample.pdf"? People in this meeting will no longer see it.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
    await expect(
      page.getByText('No files yet. Add an agenda, a deck, or a recording.'),
    ).toBeVisible();

    await host.context.close();
  });

  test("offers Delete to the host on a participant's file, and not to another participant", async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const uploader = await signUp(browser);
    const other = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [uploader.userId, other.userId],
    });

    await uploader.page.goto(`/meetings/${meeting.id}`);
    await pickFiles(uploader.page, [SAMPLE_PDF]);
    await expect(rowFor(uploader.page, 'sample.pdf')).toBeVisible();

    await other.page.goto(`/meetings/${meeting.id}`);
    const otherRow = rowFor(other.page, 'sample.pdf');
    await expect(otherRow).toBeVisible();
    await expect(otherRow.getByText('added by a member')).toBeVisible();
    await expect(otherRow.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(otherRow.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    await host.page.goto(`/meetings/${meeting.id}`);
    const hostRow = rowFor(host.page, 'sample.pdf');
    await hostRow.getByRole('button', { name: 'Delete' }).click();
    await host.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(hostRow).toHaveCount(0);

    await other.context.close();
    await uploader.context.close();
    await host.context.close();
  });

  test('accepts a file dropped onto the section', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    const transfer = await page.evaluateHandle(
      ([name, bytes]) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(
          new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }),
        );

        return dataTransfer;
      },
      ['dropped.pdf', [...fs.readFileSync(SAMPLE_PDF)]] as const,
    );
    const target = page.getByTestId('files-drop-target');
    await target.dispatchEvent('dragenter', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer });
    await target.dispatchEvent('drop', { dataTransfer: transfer });

    await expect(rowFor(page, 'dropped.pdf')).toBeVisible();
    await expect(rowFor(page, 'dropped.pdf').getByText('Processing')).toBeHidden({
      timeout: 10_000,
    });

    await host.context.close();
  });

  test('uploads several picked files one request at a time', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const started: number[] = [];
    const finished: number[] = [];
    page.on('request', (request) => {
      if (isUploadRequest(request)) {
        started.push(Date.now());
      }
    });
    page.on('response', (response) => {
      if (isUploadRequest(response.request())) {
        finished.push(Date.now());
      }
    });
    await page.goto(`/meetings/${meeting.id}`);

    await pickFiles(page, [SAMPLE_PDF, SAMPLE_PNG]);

    await expect(rowFor(page, 'sample.pdf')).toBeVisible();
    await expect(rowFor(page, 'sample.png')).toBeVisible();
    await expect.poll(() => finished.length).toBe(2);
    expect(started).toHaveLength(2);
    // The second request starts only after the first response: one at a time, so one
    // rejection cannot take the rest with it.
    expect(started[1] ?? 0).toBeGreaterThanOrEqual(finished[0] ?? Number.POSITIVE_INFINITY);

    await host.context.close();
  });
});
