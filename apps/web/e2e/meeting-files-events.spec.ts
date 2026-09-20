import type { Locator, Page, Request } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { SAMPLE_PDF, SAMPLE_PNG, createMeetingViaApi, signUp } from './fixtures';
import { scaled } from './timeouts';

/** The row for a file, by name. Rows are list items inside the Files list. */
const rowFor = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

const pathOf = (request: Request): string => new URL(request.url()).pathname;

/** A refetch of the whole list — what the poll does, and what the stream exists to avoid. */
const isListRequest = (request: Request): boolean =>
  request.method() === 'GET' && pathOf(request).endsWith('/files');

const isEventsRequest = (request: Request): boolean =>
  request.method() === 'GET' && pathOf(request).endsWith('/files/events');

const pickFiles = (page: Page, files: string[]): Promise<void> =>
  page.locator('input[type="file"]').setInputFiles(files);

/**
 * The value of `read()` once it has not changed for `quietMs` — the only signal a backoff
 * that has stopped can give, since a give-up is silence rather than an event.
 */
async function untilQuiet(read: () => number, quietMs: number): Promise<number> {
  let last = read();
  let since = Date.now();

  await expect
    .poll(
      () => {
        const now = read();

        if (now !== last) {
          last = now;
          since = Date.now();
        }

        return Date.now() - since >= quietMs;
      },
      { timeout: scaled(30_000) },
    )
    .toBe(true);

  return last;
}

/** Waits for the first list to have landed, so a later upload cannot trigger a refetch. */
const waitForEmptyList = (page: Page): Promise<void> =>
  expect(page.getByText('No files yet', { exact: false }))
    .toBeVisible()
    .then(() => undefined);

test.describe('live file updates', () => {
  test('settles a processed file without refetching the list', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;

    /** When each list refetch happened, so the window around the upload can be inspected. */
    const listRequests: number[] = [];
    let openedStream = false;
    /** When the stream's headers arrived — the moment the page refetches the list. */
    let streamOpenedAt: number | null = null;
    page.on('request', (request) => {
      if (isListRequest(request)) {
        listRequests.push(Date.now());
      }

      if (isEventsRequest(request)) {
        openedStream = true;
      }
    });
    page.on('response', (response) => {
      if (isEventsRequest(response.request()) && response.ok()) {
        streamOpenedAt = Date.now();
      }
    });

    await page.goto(`/meetings/${meeting.id}`);
    await waitForEmptyList(page);
    // The list is fetched once more the moment the stream opens: only a list requested after
    // the server subscribed this page can be trusted to hold what no event will repeat. Wait
    // for that fetch to have been sent, so the window below holds the upload's alone.
    await expect
      .poll(() => {
        const openedAt = streamOpenedAt;

        return openedAt !== null && listRequests.some((at) => at >= openedAt);
      })
      .toBe(true);

    await pickFiles(page, [SAMPLE_PDF]);

    const row = rowFor(page, 'sample.pdf');
    await expect(row.getByText('Processing')).toBeVisible();
    const uploadedAt = Date.now();

    // Five seconds, not the ten the Phase 1 spec allows: the chip goes when the worker says
    // so, not at the next poll.
    await expect(row.getByText('Processing')).toBeHidden({ timeout: scaled(5_000) });
    const settledAt = Date.now();

    expect(openedStream).toBe(true);
    // The assertion the whole phase is for: nothing asked the API what the list looked like
    // between the upload and the row settling. The `ready` event is what moved it.
    expect(listRequests.filter((at) => at >= uploadedAt && at <= settledAt)).toEqual([]);

    await host.context.close();
  });

  test('shows a second tab the upload without a reload', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const watcher = await host.context.newPage();

    await host.page.goto(`/meetings/${meeting.id}`);
    await waitForEmptyList(host.page);
    await watcher.goto(`/meetings/${meeting.id}`);
    await waitForEmptyList(watcher);

    await pickFiles(host.page, [SAMPLE_PNG]);

    // The second tab never reloads and never uploads: the row arrives because the API
    // announced somebody else's upload on the stream it is holding open.
    await expect(rowFor(watcher, 'sample.png')).toBeVisible({ timeout: scaled(10_000) });
    await expect(rowFor(watcher, 'sample.png').getByText('Processing')).toBeHidden({
      timeout: scaled(10_000),
    });

    await watcher.close();
    await host.context.close();
  });

  test('falls back to polling when the stream cannot be opened', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;

    // Every attempt fails, which is what a proxy that will not hold a response open looks
    // like. Three of them inside a minute is the give-up rule.
    let attempts = 0;
    await page.route('**/files/events', (route) => {
      attempts += 1;
      void route.abort();
    });

    const listRequests: number[] = [];
    page.on('request', (request) => {
      if (isListRequest(request)) {
        listRequests.push(Date.now());
      }
    });

    await page.goto(`/meetings/${meeting.id}`);
    await waitForEmptyList(page);

    // Upload only once the stream has been given up on, so the poll is the only thing left
    // that can settle the row. The backoff spends about three seconds getting here, and the
    // count is not asserted exactly: the dev server's double mount adds one attempt the
    // page aborts itself. What the give-up rule promises is that the attempts *stop*, and
    // with backoffs of one and two seconds, five quiet seconds is that.
    await expect.poll(() => attempts, { timeout: scaled(15_000) }).toBeGreaterThanOrEqual(3);
    const givenUpAt = await untilQuiet(() => attempts, 5_000);

    await pickFiles(page, [SAMPLE_PDF]);

    const row = rowFor(page, 'sample.pdf');
    await expect(row.getByText('Processing')).toBeVisible();

    const beforeSettling = listRequests.length;
    // Ten seconds rather than the stream path's five: a poll costs up to three more, and
    // "slower but still correct" is the whole point of keeping it.
    await expect(row.getByText('Processing')).toBeHidden({ timeout: scaled(10_000) });

    // The list was refetched while the row was processing — that is the poll, and nothing
    // else could have moved the chip.
    expect(listRequests.length).toBeGreaterThan(beforeSettling);
    // And the stream was not tried again yet: after giving up, the poll has the page to
    // itself for a minute before the next attempt, which is well past this test's end.
    expect(attempts).toBe(givenUpAt);

    await host.context.close();
  });

  test('hangs up the stream when the page is left', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;

    let open = 0;
    page.on('request', (request) => {
      if (isEventsRequest(request)) {
        open += 1;
      }
    });
    const settled = (request: Request): void => {
      if (isEventsRequest(request)) {
        open -= 1;
      }
    };
    page.on('requestfinished', settled);
    page.on('requestfailed', settled);

    await page.goto(`/meetings/${meeting.id}`);
    await waitForEmptyList(page);
    await expect.poll(() => open).toBe(1);

    // A client-side navigation, not a reload: the browser would cancel everything on a
    // reload, which would prove nothing about the effect's cleanup.
    await page.getByRole('link', { name: 'Back to your meetings' }).click();
    await expect(page).toHaveURL(/\/$/);

    // Nothing is left pending. A stream nobody is reading is a connection the API holds
    // open until its TTL, and one per visit adds up.
    await expect.poll(() => open, { timeout: scaled(10_000) }).toBe(0);

    await host.context.close();
  });
});
