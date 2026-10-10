import type { Browser } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  DIGEST_FAILED_MESSAGE,
  claude,
  digestButtons,
  digestPart,
  digestSection,
  digestViaApi,
  expectCurrentDigest,
  failedDigest,
  generatingDigest,
  isDigestRequest,
  isStillTheSameLoad,
  markLoaded,
  openMeetingPage,
  outOfDateMark,
  queuedDigest,
  requestDigestStatusViaApi,
  retryDigestButton,
  uploadRecording,
} from './digest';
import type { CreatedMeeting, SignedInUser } from './fixtures';
import { createMeetingViaApi, signUp } from './fixtures';
import { scaled } from './timeouts';
import { rowFor, transcriber, transcriptLink } from './transcription';

const LAUNCH = 'Ship the launch on Friday.';
const PRICING = 'Keep the pricing page as it is.';

interface Members {
  host: SignedInUser;
  /** A participant, and the one who uploads the meeting's recording. */
  uploader: SignedInUser;
  /** A participant who uploaded nothing: sees the digest, and may ask for none. */
  other: SignedInUser;
  meeting: CreatedMeeting;
}

async function meetingOfThree(browser: Browser): Promise<Members> {
  const [host, uploader, other] = await Promise.all([
    signUp(browser),
    signUp(browser),
    signUp(browser),
  ]);
  const meeting = await createMeetingViaApi(host.token, {
    title: 'Launch review',
    participantIds: [uploader.userId, other.userId],
  });

  return { host, uploader, other, meeting };
}

const pagesOf = ({ host, uploader, other }: Members) => [host.page, uploader.page, other.page];

/** Every member's page on the meeting, loaded: its files drawn and its digest answered. */
async function openForAll(members: Members): Promise<void> {
  await Promise.all(
    pagesOf(members).map(async (page) => {
      await openMeetingPage(page, members.meeting.id);
      await expect(rowFor(page, 'launch.mp3')).toBeVisible();
      await markLoaded(page);
    }),
  );
}

async function closeAll({ host, uploader, other }: Members): Promise<void> {
  await Promise.all([host, uploader, other].map(({ context }) => context.close()));
}

test.describe('Retry, and the digests nobody asks for, on the meeting page', () => {
  // Both fakes, at both ends — and `claude.reset` switches the digest back on, so a test
  // that failed with it off does not leave the API generating nothing for every spec after.
  test.beforeEach(() => Promise.all([transcriber.reset(), claude.reset()]));
  test.afterEach(() => Promise.all([transcriber.reset(), claude.reset()]));

  test('gives a recording transcribed with the setting off its digest once the API catches up, with nobody asking', async ({
    browser,
  }) => {
    const members = await meetingOfThree(browser);
    const { host, uploader, other, meeting } = members;
    const key = claude.key();
    await claude.hold(key);

    await claude.setting('off');
    await uploader.page.goto(`/meetings/${meeting.id}`);
    await uploadRecording(uploader.page, 'launch.mp3', { decisions: [LAUNCH], holdKey: key });
    await expect(transcriptLink(rowFor(uploader.page, 'launch.mp3'))).toBeVisible();
    await claude.setting('on');

    // Switched on again, nothing is stored and nothing is offered: no section for anybody,
    // and the route has nothing to retry for the two who could retry a failure.
    await openForAll(members);
    expect((await digestViaApi(host.token, meeting.id)).status).toBeUndefined();
    await Promise.all(pagesOf(members).map((page) => expect(digestSection(page)).toHaveCount(0)));
    expect(await requestDigestStatusViaApi(host.token, meeting.id)).toBe(409);
    expect(await requestDigestStatusViaApi(uploader.token, meeting.id)).toBe(409);
    expect(await requestDigestStatusViaApi(other.token, meeting.id)).toBe(404);

    // What the restart that switches the setting on does. The generation is held, so every
    // page can be seen saying so — and none of them has anything to press, then or after.
    await claude.catchUp();
    await Promise.all(pagesOf(members).map((page) => expect(generatingDigest(page)).toBeVisible()));
    await Promise.all(pagesOf(members).map((page) => expect(digestButtons(page)).toHaveCount(0)));

    await claude.release(key);
    await Promise.all(pagesOf(members).map(expectCurrentDigest));
    await expect(digestPart(other.page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
    await Promise.all(pagesOf(members).map((page) => expect(digestButtons(page)).toHaveCount(0)));
    expect(await requestDigestStatusViaApi(host.token, meeting.id)).toBe(409);
    expect(await Promise.all(pagesOf(members).map(isStillTheSameLoad))).toEqual([true, true, true]);

    await closeAll(members);
  });

  test('offers Retry on a failed digest to the same two, and ends in a digest once Claude answers again', async ({
    browser,
  }) => {
    const members = await meetingOfThree(browser);
    const { host, uploader, other, meeting } = members;
    const down = claude.key();
    await claude.hold(down);
    await uploader.page.goto(`/meetings/${meeting.id}`);
    await uploadRecording(uploader.page, 'launch.mp3', { decisions: [LAUNCH], failsWhile: down });
    await expect(failedDigest(uploader.page)).toBeVisible();

    await openForAll(members);
    await Promise.all(
      pagesOf(members).map(async (page) => {
        await expect(failedDigest(page)).toBeVisible();
        await expect(digestSection(page)).toContainText(DIGEST_FAILED_MESSAGE);
      }),
    );
    await expect(retryDigestButton(host.page)).toBeVisible();
    await expect(retryDigestButton(uploader.page)).toBeVisible();
    // The failure and its reason, and nothing to press.
    await expect(digestButtons(other.page)).toHaveCount(0);
    expect(await requestDigestStatusViaApi(other.token, meeting.id)).toBe(404);

    // While Claude is still down a Retry is taken, claimed, and failed again — three states
    // in less than one look at the page. So what is waited for is what caused them: the
    // answer, then the API saying it failed a second time, then the page saying so too.
    const failedAt = (await digestViaApi(host.token, meeting.id)).version;
    const answered = host.page.waitForResponse(isDigestRequest);
    await retryDigestButton(host.page).click();
    expect((await answered).status()).toBe(200);
    await expect
      .poll(
        async () => {
          const digest = await digestViaApi(host.token, meeting.id);

          return digest.status === 'failed' && digest.version > failedAt;
        },
        { timeout: scaled(10_000) },
      )
      .toBe(true);
    await expect(failedDigest(host.page)).toBeVisible();
    await expect(retryDigestButton(host.page)).toBeEnabled();
    await expect(queuedDigest(host.page)).toBeHidden();
    await expect(generatingDigest(host.page)).toBeHidden();

    // Claude answers again, and it is the uploader who asks this time.
    await claude.release(down);
    await retryDigestButton(uploader.page).click();

    await Promise.all(
      pagesOf(members).map(async (page) => {
        await expectCurrentDigest(page);
        await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
        await expect(failedDigest(page)).toBeHidden();
        await expect(digestButtons(page)).toHaveCount(0);
      }),
    );
    expect(await Promise.all(pagesOf(members).map(isStillTheSameLoad))).toEqual([true, true, true]);

    await closeAll(members);
  });

  test('offers nothing for a digest the setting left out of date, and the catch-up replaces it', async ({
    browser,
  }) => {
    const host = await signUp(browser);
    const meeting = await createMeetingViaApi(host.token, { title: 'Launch review' });
    const { page } = host;
    await page.goto(`/meetings/${meeting.id}`);
    await uploadRecording(page, 'launch.mp3', { decisions: [LAUNCH] });
    await expectCurrentDigest(page);

    // Off: the second recording is transcribed and asks for nothing. The digest stored
    // earlier is still shown, and marked — with no way offered to bring it up to date.
    await claude.setting('off');
    await uploadRecording(page, 'pricing.mp3', { decisions: [PRICING] });
    await expect(outOfDateMark(page)).toBeVisible();
    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH]);
    await openMeetingPage(page, meeting.id);
    await expect(outOfDateMark(page)).toBeVisible();
    await expect(digestButtons(page)).toHaveCount(0);
    expect(await requestDigestStatusViaApi(host.token, meeting.id)).toBe(409);

    // On again, nothing has started by itself — and still nothing is offered: bringing it
    // up to date is nobody's to ask for.
    await claude.setting('on');
    await openMeetingPage(page, meeting.id);
    await markLoaded(page);
    await expect(outOfDateMark(page)).toBeVisible();
    await expect(digestButtons(page)).toHaveCount(0);
    expect(await requestDigestStatusViaApi(host.token, meeting.id)).toBe(409);

    await claude.catchUp();

    await expect(digestPart(page, 'Decisions').getByRole('listitem')).toHaveText([LAUNCH, PRICING]);
    await expectCurrentDigest(page);
    await expect(digestButtons(page)).toHaveCount(0);
    expect(await isStillTheSameLoad(page)).toBe(true);

    await host.context.close();
  });
});
