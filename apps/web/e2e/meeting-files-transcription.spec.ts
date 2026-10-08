import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  SAMPLE_PDF,
  SAMPLE_PNG,
  createMeetingViaApi,
  listMeetingFilesViaApi,
  signUp,
} from './fixtures';
import {
  ENDPOINT_MARKER,
  TRANSCRIPTION_FAILED_MESSAGE,
  downloadFrom,
  failedChip,
  openTranscript,
  pickRecordings,
  queuedChip,
  recordingNamed,
  rowFor,
  transcriber,
  transcribingChip,
  transcriptLink,
  transcriptStatusViaApi,
} from './transcription';

/** What the fake answers with. The dash is not ASCII: a transcript shown in the wrong charset
 *  would not read like this. */
const SENTENCE = 'Good morning, everyone — shall we start with the engine?';

/** Set on the page once it has loaded, and gone if the page is ever loaded again. */
const markLoaded = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Object.assign(window, { e2eLoadedOnce: true });
  });
const isStillTheSameLoad = (page: Page): Promise<boolean> =>
  page.evaluate(() => 'e2eLoadedOnce' in window);

/** A row that is ready, downloadable, and says nothing at all about transcription. */
async function expectNoTranscription(page: Page, name: string): Promise<void> {
  const row = rowFor(page, name);

  await expect(row.getByText('Processing', { exact: true })).toBeHidden();
  await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(row).not.toContainText(/transcri/i);
  await expect(row.getByRole('link')).toHaveCount(0);
}

test.describe('transcription on the meeting page', () => {
  // Both ends: a test that failed half-way must not leave the API's one transcription at a
  // time waiting on a request nobody will ever answer.
  test.beforeEach(() => transcriber.reset());
  test.afterEach(() => transcriber.reset());

  test('takes a recording from Queued to an open transcript, downloadable throughout', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const ahead = recordingNamed('ahead.mp3');
    const standup = recordingNamed('standup.mp3');
    await transcriber.hold(ahead);
    await transcriber.hold(standup);
    await page.goto(`/meetings/${meeting.id}`);
    await markLoaded(page);

    // The API transcribes one recording at a time, so while the first is held the second has
    // nowhere to go: Queued for as long as the test needs it, not for one 250 ms poll.
    await pickRecordings(page, [ahead]);
    await expect(transcribingChip(rowFor(page, 'ahead.mp3'))).toBeVisible();
    await pickRecordings(page, [standup]);

    const row = rowFor(page, 'standup.mp3');
    await expect(queuedChip(row)).toBeVisible();
    // Ready before it is transcribed: the file's own checks passed, and that is all Download
    // waits for.
    await expect(row.getByText('Processing', { exact: true })).toBeHidden();
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    await transcriber.answer(ahead, 'Ahead of the standup.');
    await expect(transcribingChip(row)).toBeVisible();
    await expect(queuedChip(row)).toBeHidden();
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    await transcriber.answer(standup, SENTENCE);
    await expect(transcriptLink(row)).toBeVisible();
    await expect(transcribingChip(row)).toBeHidden();

    const tab = await openTranscript(page, row);
    // The text itself, on screen, as text: not a link that merely exists.
    await expect(tab.locator('body')).toHaveText(SENTENCE);
    expect(await tab.evaluate(() => document.contentType)).toBe('text/plain');
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    // Every change above arrived on its own.
    expect(await isStillTheSameLoad(page)).toBe(true);

    await host.context.close();
  });

  test('shows no transcription status on a PDF or a PNG', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const standup = recordingNamed('standup.mp3');
    await transcriber.answer(standup, SENTENCE);
    await page.goto(`/meetings/${meeting.id}`);

    await page.locator('input[type="file"]').setInputFiles([SAMPLE_PDF, SAMPLE_PNG]);
    await pickRecordings(page, [standup]);

    // The recording was uploaded last and is done, so the two before it have had every
    // chance to show a status of their own.
    await expect(transcriptLink(rowFor(page, 'standup.mp3'))).toBeVisible();

    await expectNoTranscription(page, 'sample.pdf');
    await expectNoTranscription(page, 'sample.png');

    await host.context.close();
  });

  test('shows a participant the same status and the same transcript', async ({ browser }) => {
    const host = await signUp(browser);
    const guest = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [guest.userId],
    });
    const standup = recordingNamed('standup.mp3');
    await transcriber.hold(standup);
    await host.page.goto(`/meetings/${meeting.id}`);
    await guest.page.goto(`/meetings/${meeting.id}`);
    await expect(guest.page.getByText('No files yet', { exact: false })).toBeVisible();
    await markLoaded(guest.page);

    await pickRecordings(host.page, [standup]);

    // Somebody else's recording, on a page that neither uploaded it nor reloaded.
    const guestRow = rowFor(guest.page, 'standup.mp3');
    await expect(transcribingChip(guestRow)).toBeVisible();
    await expect(guestRow.getByText('added by a member')).toBeVisible();

    await transcriber.answer(standup, SENTENCE);

    const guestTab = await openTranscript(guest.page, guestRow);
    await expect(guestTab.locator('body')).toHaveText(SENTENCE);
    expect(await isStillTheSameLoad(guest.page)).toBe(true);

    const hostTab = await openTranscript(host.page, rowFor(host.page, 'standup.mp3'));
    await expect(hostTab.locator('body')).toHaveText(SENTENCE);

    await Promise.all([host.context.close(), guest.context.close()]);
  });

  test('shows why a recording failed while the one beside it finishes', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const garbled = recordingNamed('garbled.mp3');
    const retro = recordingNamed('retro.mp3');
    await transcriber.fail(garbled);
    await transcriber.answer(retro, SENTENCE);
    await page.goto(`/meetings/${meeting.id}`);

    await pickRecordings(page, [garbled, retro]);

    const failedRow = rowFor(page, 'garbled.mp3');
    await expect(failedChip(failedRow)).toBeVisible();
    await expect(transcriptLink(rowFor(page, 'retro.mp3'))).toBeVisible();

    // The reason, in the chip's tooltip. The pointer is nudged first: React Aria does not
    // count an arrival it never saw travel as a hover (see `meeting-files-retry.spec.ts`).
    await page.mouse.move(1, 1);
    await failedChip(failedRow).hover();
    await expect(page.getByText(TRANSCRIPTION_FAILED_MESSAGE)).toBeVisible();
    // The API's copy and nothing of the endpoint's: its error body stays in the server log.
    await expect(page.getByText(ENDPOINT_MARKER, { exact: false })).toHaveCount(0);

    // It is the transcription that failed. The file is as ready as its neighbour.
    await expect(failedRow.getByText('Processing failed')).toHaveCount(0);
    await expect(transcriptLink(failedRow)).toHaveCount(0);
    expect((await downloadFrom(page, failedRow)).equals(garbled.file.buffer)).toBe(true);

    const tab = await openTranscript(page, rowFor(page, 'retro.mp3'));
    await expect(tab.locator('body')).toHaveText(SENTENCE);

    await host.context.close();
  });

  test('removes a recording deleted while it is being transcribed', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const standup = recordingNamed('standup.mp3');
    await transcriber.hold(standup);
    await page.goto(`/meetings/${meeting.id}`);

    await pickRecordings(page, [standup]);
    const row = rowFor(page, 'standup.mp3');
    await expect(transcribingChip(row)).toBeVisible();
    const [file] = await listMeetingFilesViaApi(host.token, meeting.id);

    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);

    await expect(page.getByText('No files yet', { exact: false })).toBeVisible();

    // Whisper finishing afterwards must not bring any of it back. The API transcribes one
    // recording at a time, oldest first, so a second one reaching its transcript is the
    // signal that the late answer has been dealt with — there is no event to wait for when
    // the right outcome is that nothing happens.
    await transcriber.answer(standup, SENTENCE);
    await pickRecordings(page, [recordingNamed('afterwards.mp3')]);
    await expect(transcriptLink(rowFor(page, 'afterwards.mp3'))).toBeVisible();

    await expect(row).toHaveCount(0);
    expect(await transcriptStatusViaApi(host.token, meeting.id, file?.id ?? '')).toBe(404);

    await host.context.close();
  });
});
