import type { Locator, Page, Request, Response } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  LARGE_FILE_BYTES,
  MEETING_FILE_CHUNK_SIZE_BYTES,
  createMeetingViaApi,
  signUp,
  sparsePdf,
} from './fixtures';

const LARGE_NAME = 'meeting-files-e2e-large.pdf';
const CHUNKS = Math.ceil(LARGE_FILE_BYTES / MEETING_FILE_CHUNK_SIZE_BYTES);

const rowFor = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

const pickFiles = (page: Page, files: string[]): Promise<void> =>
  page.locator('input[type="file"]').setInputFiles(files);

/** `…/files/uploads/<id>/chunks/<index>` → the index, or `null` for any other request. */
function chunkIndexOf(request: Request): number | null {
  const match = /\/files\/uploads\/[^/]+\/chunks\/(\d+)$/.exec(new URL(request.url()).pathname);

  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Every chunk the page sent and every one the server acknowledged, so a resend is visible as
 * a repeat.
 *
 * The two differ, and the difference is the point: a chunk in flight when the page reloads or
 * the network drops may reach the server whose 204 never reaches the page. It was sent once
 * and stored once; only the acknowledgement was lost.
 */
function watchChunks(page: Page): { requested: number[]; acknowledged: number[] } {
  const requested: number[] = [];
  const acknowledged: number[] = [];

  page.on('request', (request: Request) => {
    const index = chunkIndexOf(request);

    if (index !== null && request.method() === 'PUT') {
      requested.push(index);
    }
  });

  page.on('response', (response: Response) => {
    const index = chunkIndexOf(response.request());

    if (index !== null && response.status() === 204) {
      acknowledged.push(index);
    }
  });

  return { requested, acknowledged };
}

test.describe('uploading a file too large for one request', () => {
  test('sends it in chunks, with a percentage, and it lands in the list', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const { acknowledged } = watchChunks(page);
    const singleRequestUploads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/files')) {
        singleRequestUploads.push(request.url());
      }
    });

    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [sparsePdf(LARGE_NAME, LARGE_FILE_BYTES)]);

    const uploading = rowFor(page, LARGE_NAME);
    await expect(uploading).toBeVisible();
    await expect(uploading.getByText('150 MB')).toBeVisible();
    // A percentage, which only a chunked upload can report before the whole file is sent.
    await expect(uploading.getByText(/\d+%/)).toBeVisible();

    // The file arrives as an ordinary meeting file: Download is a control only a stored
    // file has. **Not the Processing chip** — since Phase 4 the row learns it is `ready`
    // from the event stream within milliseconds of the worker finishing, so waiting for
    // that chip is waiting for a state the row may never be seen in.
    await expect(uploading.getByRole('button', { name: 'Download' })).toBeVisible({
      timeout: 90_000,
    });
    await expect(uploading.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

    expect(acknowledged.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: CHUNKS }, (_, index) => index),
    );
    // The single-request route was not used: this file goes the other way entirely.
    expect(singleRequestUploads).toEqual([]);

    await host.context.close();
  });

  test('survives the network dropping, and re-sends only what was not acknowledged', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page, context } = host;
    const { acknowledged } = watchChunks(page);

    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [sparsePdf(LARGE_NAME, LARGE_FILE_BYTES)]);

    // Cut the connection once the server has some chunks, then give it back.
    await expect.poll(() => acknowledged.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await context.setOffline(true);
    await page.waitForTimeout(1_000);
    await context.setOffline(false);

    const row = rowFor(page, LARGE_NAME);
    // Download rather than the Processing chip, for the reason above: the stream can move
    // the row past `processing` faster than an assertion can catch it.
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 90_000 });

    // Every chunk exactly once: the retry re-sent the chunk that was in flight when the
    // connection went, and nothing the server had already acknowledged.
    expect(acknowledged.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: CHUNKS }, (_, index) => index),
    );

    await host.context.close();
  });

  test('resumes after a reload once the same file is picked again', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    // One watcher for the whole test: the page survives the reload, and so does the record of
    // what was sent, which is what makes "sent twice" visible at all.
    const { requested, acknowledged } = watchChunks(page);

    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [sparsePdf(LARGE_NAME, LARGE_FILE_BYTES)]);
    await expect.poll(() => acknowledged.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    await page.reload();
    const sentBeforeReload = requested.length;

    // A browser cannot keep a File across a reload, so resuming starts with picking it again.
    await pickFiles(page, [sparsePdf(LARGE_NAME, LARGE_FILE_BYTES)]);

    const row = rowFor(page, LARGE_NAME);
    await expect(row.getByText(/Resuming/)).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 90_000 });

    // The run after the reload sent fewer chunks than the file has: the ones the server
    // already held were not sent again.
    expect(requested.length - sentBeforeReload).toBeLessThan(CHUNKS);
    // At most one chunk was sent twice: the one in flight when the reload cancelled it,
    // which the server never acknowledged and the resume therefore has to send again. That
    // is resume working. An exact count per run would be a race either way — a chunk can
    // land in the moment between the snapshot and the reload — and the claim resume makes
    // is about what the server *holds*, which is the assertion below.
    expect(requested.length - new Set(requested).size).toBeLessThanOrEqual(1);
    expect(new Set(acknowledged).size).toBe(acknowledged.length);

    await host.context.close();
  });

  test('cancel removes the row and tells the server to drop the session', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const { acknowledged } = watchChunks(page);
    const aborted: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/files/uploads/')) {
        aborted.push(request.url());
      }
    });

    await page.goto(`/meetings/${meeting.id}`);
    await pickFiles(page, [sparsePdf(LARGE_NAME, LARGE_FILE_BYTES)]);
    await expect.poll(() => acknowledged.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    const row = rowFor(page, LARGE_NAME);
    await row.getByRole('button', { name: 'Cancel' }).click();

    await expect(row).toHaveCount(0);
    await expect.poll(() => aborted.length, { timeout: 10_000 }).toBe(1);
    // Nothing was created: the file only exists once `complete` says so.
    await expect(page.getByText('No files yet', { exact: false })).toBeVisible();

    await host.context.close();
  });
});
