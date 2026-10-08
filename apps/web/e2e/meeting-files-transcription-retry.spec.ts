import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { createMeetingViaApi, listMeetingFilesViaApi, signUp } from './fixtures';
import {
  downloadFrom,
  failedChip,
  isTranscriptionRetry,
  openTranscript,
  pickRecordings,
  queuedChip,
  recordingNamed,
  retryButton,
  retryTranscriptionStatusViaApi,
  rowFor,
  transcriber,
  transcribingChip,
  transcriptionStatusViaApi,
  transcriptLink,
} from './transcription';

/** What the fake answers with once it is answering again. */
const SENTENCE = 'Second time lucky — the engine review, from the top.';

/** Set on the page once it has loaded, and gone if the page is ever loaded again. */
const markLoaded = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Object.assign(window, { e2eLoadedOnce: true });
  });
const isStillTheSameLoad = (page: Page): Promise<boolean> =>
  page.evaluate(() => 'e2eLoadedOnce' in window);

test.describe('retrying a failed transcription', () => {
  // Both ends, as in `meeting-files-transcription.spec.ts`: a test that failed half-way must
  // not leave the API's one transcription at a time waiting on a held request.
  test.beforeEach(() => transcriber.reset());
  test.afterEach(() => transcriber.reset());

  test('takes a failed recording back to Queued and on to its transcript, downloadable throughout', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const uploader = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [uploader.userId],
    });
    // The uploader, who is not the host: the half of the gate the next test does not press.
    const { page } = uploader;
    const standup = recordingNamed('standup.mp3');
    await transcriber.fail(standup);
    await page.goto(`/meetings/${meeting.id}`);
    await markLoaded(page);

    await pickRecordings(page, [standup]);
    const row = rowFor(page, 'standup.mp3');
    await expect(failedChip(row)).toBeVisible();
    await expect(retryButton(row)).toBeVisible();
    // It is the transcription that failed: the file is ready, and this Retry is not the file's.
    await expect(row.getByText('Processing failed')).toHaveCount(0);
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    // The API transcribes one recording at a time, so with another one held the retried
    // recording has nowhere to go: Queued for as long as the test needs it, not for one poll.
    const ahead = recordingNamed('ahead.mp3');
    await transcriber.hold(ahead);
    await pickRecordings(page, [ahead]);
    await expect(transcribingChip(rowFor(page, 'ahead.mp3'))).toBeVisible();
    // Whisper is back for the standup, and slow: its next request is held, not failed.
    await transcriber.hold(standup);

    await retryButton(row).click();

    await expect(queuedChip(row)).toBeVisible();
    await expect(failedChip(row)).toBeHidden();
    // Nothing is failed any more, so there is nothing to retry.
    await expect(retryButton(row)).toHaveCount(0);
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    await transcriber.answer(ahead, 'Ahead of the standup.');
    await expect(transcribingChip(row)).toBeVisible();
    await expect(queuedChip(row)).toBeHidden();
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    await transcriber.answer(standup, SENTENCE);
    await expect(transcriptLink(row)).toBeVisible();
    await expect(retryButton(row)).toHaveCount(0);

    // The second answer, not a leftover of the first: the first was a 500 with no text in it.
    const tab = await openTranscript(page, row);
    await expect(tab.locator('body')).toHaveText(SENTENCE);
    expect((await downloadFrom(page, row)).equals(standup.file.buffer)).toBe(true);

    // Every change above arrived on its own.
    expect(await isStillTheSameLoad(page)).toBe(true);

    await Promise.all([host.context.close(), uploader.context.close()]);
  });

  test('comes back failed, with Retry again, for as long as Whisper stays down', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Engine review' });
    const { page } = host;
    const standup = recordingNamed('standup.mp3');
    // Until told otherwise at the end, every request for this recording fails.
    await transcriber.fail(standup);
    await page.goto(`/meetings/${meeting.id}`);
    await markLoaded(page);

    await pickRecordings(page, [standup]);
    const row = rowFor(page, 'standup.mp3');
    await expect(failedChip(row)).toBeVisible();
    const [file] = await listMeetingFilesViaApi(host.token, meeting.id);
    const fileId = file?.id ?? '';

    // Whisper is still down. The API takes the retry — its answer says queued — and the
    // worker fails the recording a second time, all within a fraction of a second.
    const retried = page.waitForResponse(isTranscriptionRetry);
    await retryButton(row).click();
    const answer = await retried;
    expect(answer.status()).toBe(200);
    expect(((await answer.json()) as { transcriptionStatus: string }).transcriptionStatus).toBe(
      'queued',
    );
    await expect
      .poll(() => transcriptionStatusViaApi(host.token, meeting.id, fileId))
      .toBe('failed');

    // The page that pressed ends where the API did. Its own answer said queued, and may well
    // have arrived after the stream said failed: it must not be what the row is left showing.
    await expect(failedChip(row)).toBeVisible();
    await expect(retryButton(row)).toBeVisible();
    await expect(queuedChip(row)).toHaveCount(0);
    await expect(transcribingChip(row)).toHaveCount(0);

    // Which is what lets the same row recover the recording once Whisper is back.
    await transcriber.answer(standup, SENTENCE);
    await retryButton(row).click();
    await expect(transcriptLink(row)).toBeVisible();
    await expect(retryButton(row)).toHaveCount(0);
    const tab = await openTranscript(page, row);
    await expect(tab.locator('body')).toHaveText(SENTENCE);
    expect(await isStillTheSameLoad(page)).toBe(true);

    await host.context.close();
  });

  test('offers Retry to the uploader and the host, and to no other participant', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const uploader = await signUp(browser);
    const other = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Engine review',
      participantIds: [uploader.userId, other.userId],
    });
    const standup = recordingNamed('standup.mp3');
    await transcriber.fail(standup);
    await host.page.goto(`/meetings/${meeting.id}`);
    await uploader.page.goto(`/meetings/${meeting.id}`);
    await other.page.goto(`/meetings/${meeting.id}`);
    await expect(other.page.getByText('No files yet', { exact: false })).toBeVisible();
    await markLoaded(other.page);

    await pickRecordings(uploader.page, [standup]);

    const uploaderRow = rowFor(uploader.page, 'standup.mp3');
    await expect(failedChip(uploaderRow)).toBeVisible();
    await expect(retryButton(uploaderRow)).toBeVisible();

    // Someone else's recording: they see that it failed and can still download it, but may
    // neither retry nor delete it — and the API agrees with the page about that.
    const otherRow = rowFor(other.page, 'standup.mp3');
    await expect(failedChip(otherRow)).toBeVisible();
    await expect(otherRow.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(retryButton(otherRow)).toHaveCount(0);
    await expect(otherRow.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    const [file] = await listMeetingFilesViaApi(host.token, meeting.id);
    expect(await retryTranscriptionStatusViaApi(other.token, meeting.id, file?.id ?? '')).toBe(404);

    // The host may retry a participant's recording, the same rule as Delete — here from the
    // keyboard: Retry is the row's first stop, the one before Download. The chip is not one,
    // since its reason is written on the row.
    const hostRow = rowFor(host.page, 'standup.mp3');
    await expect(failedChip(hostRow)).toBeVisible();
    await transcriber.answer(standup, SENTENCE);
    await hostRow.getByRole('button', { name: 'Download' }).focus();
    await host.page.keyboard.press('Shift+Tab');
    await expect(retryButton(hostRow)).toBeFocused();
    await host.page.keyboard.press('Enter');

    // The page that pressed, first: its own answer says queued, and must not be what holds
    // the row back from the transcript every other page is about to show.
    await expect(transcriptLink(hostRow)).toBeVisible();
    await expect(failedChip(hostRow)).toBeHidden();
    await expect(retryButton(hostRow)).toHaveCount(0);

    // Nobody reloaded, and nobody but the host pressed anything: the retry reaches the
    // uploader and the other participant as the same row moving on.
    await expect(transcriptLink(uploaderRow)).toBeVisible();
    await expect(transcriptLink(otherRow)).toBeVisible();
    await expect(retryButton(uploaderRow)).toHaveCount(0);
    const tab = await openTranscript(other.page, otherRow);
    await expect(tab.locator('body')).toHaveText(SENTENCE);
    expect(await isStillTheSameLoad(other.page)).toBe(true);

    await Promise.all([host.context.close(), uploader.context.close(), other.context.close()]);
  });
});
