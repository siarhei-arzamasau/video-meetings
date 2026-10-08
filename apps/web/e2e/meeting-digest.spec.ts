import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  CLAUDE_MARKER,
  DIGEST_AI_NOTE,
  DIGEST_FAILED_MESSAGE,
  claude,
  digestPart,
  digestSection,
  digestViaApi,
  expectCurrentDigest,
  failedDigest,
  generatingDigest,
  isStillTheSameLoad,
  markLoaded,
  openMeetingPage,
  outOfDateMark,
  queuedDigest,
  uploadRecording,
} from './digest';
import { createMeetingViaApi, setDisplayNameViaApi, signUp } from './fixtures';
import { downloadFrom, openTranscript, rowFor, transcriber } from './transcription';

const SUMMARY = 'The team agreed how the launch will go — and who does what.';
const LAUNCH = 'Ship the launch on Friday.';
const PRICING = 'Keep the pricing page as it is.';

const actionItems = (page: Page) => digestPart(page, 'Action items').getByRole('listitem');

/** The digest of the launch recording, whole, as everyone in the meeting should see it. */
async function expectLaunchDigest(page: Page): Promise<void> {
  await expectCurrentDigest(page);
  await expect(digestPart(page, 'Summary')).toContainText(SUMMARY);
  await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
  // A participant under their display name, a name nobody in the meeting answers to as it
  // was spoken, and nobody at all.
  await expect(actionItems(page)).toHaveText([
    'Send the deck to the venue.Owner: Ada Lovelace',
    'Call the caterer.Owner: Grace Hopper',
    'Book the room.Owner: Unassigned',
  ]);
  await expect(actionItems(page).nth(0).locator('[data-owner="participant"]')).toBeVisible();
  await expect(actionItems(page).nth(1).locator('[data-owner="name"]')).toBeVisible();
  await expect(digestSection(page).getByText(DIGEST_AI_NOTE)).toBeVisible();
}

test.describe('the digest on the meeting page', () => {
  // Both fakes, at both ends: a test that failed half-way must not leave the API's one
  // transcription or its one generation waiting on something nobody will ever answer.
  test.beforeEach(() => Promise.all([transcriber.reset(), claude.reset()]));
  test.afterEach(() => Promise.all([transcriber.reset(), claude.reset()]));

  test('takes an uploaded recording from Queued to the three parts, for everyone in the meeting', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const guest = await signUp(browser);
    await setDisplayNameViaApi(guest.token, 'Ada Lovelace');
    const ahead = await createMeetingViaApi(host.token, { title: 'Ahead of it' });
    const meeting = await createMeetingViaApi(host.token, {
      title: 'Launch review',
      participantIds: [guest.userId],
    });
    const [aheadKey, key] = [claude.key(), claude.key()];
    await Promise.all([claude.hold(aheadKey), claude.hold(key)]);

    // The API generates one digest at a time, so while another meeting's is held this one
    // has nowhere to go: Queued for as long as the test needs it, not for one 250 ms poll.
    await host.page.goto(`/meetings/${ahead.id}`);
    await uploadRecording(host.page, 'ahead.mp3', { holdKey: aheadKey });
    await expect(generatingDigest(host.page)).toBeVisible();

    await openMeetingPage(host.page, meeting.id);
    await guest.page.goto(`/meetings/${meeting.id}`);
    await Promise.all([markLoaded(host.page), markLoaded(guest.page)]);
    // No transcribed recording, so no section at all — not an empty one.
    await expect(digestSection(host.page)).toHaveCount(0);

    await uploadRecording(host.page, 'launch.mp3', {
      summary: SUMMARY,
      actionItems: [
        { description: 'Send the deck to the venue.', owner: 'Ada Lovelace' },
        { description: 'Call the caterer.', owner: 'Grace Hopper' },
        { description: 'Book the room.' },
      ],
      decisions: [LAUNCH],
      holdKey: key,
    });

    await expect(queuedDigest(host.page)).toBeVisible();
    await expect(queuedDigest(guest.page)).toBeVisible();
    await expect(digestPart(host.page, 'Summary')).toHaveCount(0);

    await claude.release(aheadKey);
    await expect(generatingDigest(host.page)).toBeVisible();
    await expect(generatingDigest(guest.page)).toBeVisible();
    await expect(queuedDigest(host.page)).toBeHidden();

    await claude.release(key);

    await Promise.all([host.page, guest.page].map(expectLaunchDigest));

    // Every change above arrived on its own, on both pages.
    expect(await isStillTheSameLoad(host.page)).toBe(true);
    expect(await isStillTheSameLoad(guest.page)).toBe(true);

    await host.context.close();
    await guest.context.close();
  });

  test('says so under each heading of a digest with no action items and no decisions', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Check-in' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    await uploadRecording(page, 'check-in.mp3', { summary: 'Nothing was decided.' });

    await expectCurrentDigest(page);
    await expect(digestPart(page, 'Action items')).toContainText('No action items were identified');
    await expect(digestPart(page, 'Decisions')).toContainText('No decisions were recorded');
    await expect(digestSection(page).getByRole('listitem')).toHaveCount(0);
    await expect(digestSection(page).getByText(DIGEST_AI_NOTE)).toBeVisible();

    await host.context.close();
  });

  test('marks the digest out of date when a second recording arrives, then replaces it', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Launch review' });
    const { page } = host;
    const key = claude.key();
    await page.goto(`/meetings/${meeting.id}`);
    await markLoaded(page);

    await uploadRecording(page, 'first.mp3', { decisions: [LAUNCH] });
    await expectCurrentDigest(page);
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);

    await claude.hold(key);
    await uploadRecording(page, 'second.mp3', { decisions: [PRICING], holdKey: key });

    // Still readable, and marked, beside the status of what will replace it.
    await expect(outOfDateMark(page)).toBeVisible();
    await expect(generatingDigest(page)).toBeVisible();
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);

    await claude.release(key);

    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH, PRICING]);
    await expectCurrentDigest(page);
    expect(await isStillTheSameLoad(page)).toBe(true);

    await host.context.close();
  });

  test('removes the digest at once when one of its recordings is deleted, and a new one follows', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Launch review' });
    const { page } = host;
    const key = claude.key();
    await page.goto(`/meetings/${meeting.id}`);
    await markLoaded(page);

    // The key is in the first recording's transcript from the start and held only later, so
    // it is the digest that follows the delete that waits.
    await uploadRecording(page, 'kept.mp3', { decisions: [LAUNCH], holdKey: key });
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
    await uploadRecording(page, 'dropped.mp3', { decisions: [PRICING] });
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH, PRICING]);
    await expectCurrentDigest(page);

    await claude.hold(key);
    await rowFor(page, 'dropped.mp3').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

    // Gone, not out of date: what the deleted recording said is not readable while its
    // replacement is written — on the page or from the API.
    await expect(generatingDigest(page)).toBeVisible();
    await expect(digestPart(page, 'Summary')).toHaveCount(0);
    await expect(digestSection(page)).not.toContainText(PRICING);
    await expect(digestSection(page)).not.toContainText(LAUNCH);
    expect((await digestViaApi(host.token, meeting.id)).content).toBeUndefined();

    await claude.release(key);

    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
    await expectCurrentDigest(page);
    expect(await isStillTheSameLoad(page)).toBe(true);

    await host.context.close();
  });

  test('shows why a digest failed, and leaves the recording and its transcript alone', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Launch review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);

    const recording = await uploadRecording(page, 'launch.mp3', { fails: true });

    await expect(failedDigest(page)).toBeVisible();
    await expect(digestSection(page)).toContainText(DIGEST_FAILED_MESSAGE);
    // The reason is the API's own sentence: nothing the provider said reaches the page.
    await expect(page.locator('body')).not.toContainText(CLAUDE_MARKER);
    await expect(digestPart(page, 'Summary')).toHaveCount(0);

    // The file is as it was: ready, downloadable, and its transcript opens.
    const row = rowFor(page, 'launch.mp3');
    expect((await downloadFrom(page, row)).equals(recording.file.buffer)).toBe(true);
    const tab = await openTranscript(page, row);
    await expect(tab.locator('body')).toContainText('Shall we begin.');

    await host.context.close();
  });

  test('shows markup in a digest as the characters it is made of', async ({ browser }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Launch review' });
    const { page } = host;
    const markup =
      '<img src=x onerror="window.e2ePwned=1"> <b>bold</b> <script>window.e2ePwned=1</script>';
    await page.goto(`/meetings/${meeting.id}`);

    await uploadRecording(page, 'launch.mp3', {
      summary: markup,
      actionItems: [{ description: markup, owner: '<i>Mallory</i>' }],
      decisions: [markup],
    });

    await expectCurrentDigest(page);
    await expect(digestPart(page, 'Summary')).toContainText(markup);
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([markup]);
    await expect(actionItems(page)).toHaveText([`${markup}Owner: <i>Mallory</i>`]);
    // Text all the way down: no element was made of any of it, and none of it ran.
    await expect(digestSection(page).locator('img, b, i, script')).toHaveCount(0);
    expect(await page.evaluate(() => 'e2ePwned' in window)).toBe(false);

    await host.context.close();
  });
});
