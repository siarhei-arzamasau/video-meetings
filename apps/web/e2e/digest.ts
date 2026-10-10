import { randomUUID } from 'node:crypto';

import type { Locator, Page, Response } from '@playwright/test';
import { expect } from '@playwright/test';

import { API_URL } from './fixtures';
import type { Recording } from './transcription';
import { pickRecordings, recordingNamed, transcriber } from './transcription';

/**
 * Where the API the suite starts listens for its scripted Claude's orders, restated as
 * `apps/api/test/e2e-web/control-server.ts` states it.
 */
const CLAUDE_CONTROL_URL = 'http://127.0.0.1:3103';

/**
 * The copy from `@repo/shared` and from the page, restated for the reason `fixtures.ts`
 * restates every other sentence: rewording one must fail a spec rather than quietly pass it.
 */
export const DIGEST_FAILED_MESSAGE = 'The digest could not be generated.';
export const DIGEST_AI_NOTE =
  "AI-generated from the transcripts of this meeting's recordings. It may contain mistakes.";

/**
 * Words only "Anthropic" says — the scripted Claude's failure carries them. Nothing the page
 * shows about a failed digest may contain them: the reason a user reads is the API's own
 * fixed copy, and the provider's stays in the server log.
 */
export const CLAUDE_MARKER = 'anthropic-internal-marker-9c1e';

async function control(method: 'PUT' | 'DELETE' | 'POST', path: string): Promise<void> {
  const response = await fetch(`${CLAUDE_CONTROL_URL}${path}`, { method });

  if (response.status !== 204) {
    throw new Error(`The scripted Claude answered ${String(response.status)} to ${method} ${path}`);
  }
}

/**
 * The spec's handle on the scripted Claude inside the API.
 *
 * What a digest holds is decided by the recording's transcript (`digestTranscript`), which a
 * spec sets through the fake transcriber. The one thing that cannot be written down ahead of
 * time is *when* — so a transcript names a key, and a generation whose transcripts name a key
 * the spec is holding waits (`holdKey`) or fails (`failsWhile`) until that key is released.
 * A key nobody holds delays and fails nothing.
 */
export const claude = {
  /** A new key, unlike any other test's. */
  key: (): string => `e2e-hold-${randomUUID()}`,
  hold: (key: string): Promise<void> => control('PUT', `/control/holds/${key}`),
  release: (key: string): Promise<void> => control('DELETE', `/control/holds/${key}`),
  /**
   * `MEETING_DIGEST_ENABLED` in the API the suite started, which boots with it on. Off, a
   * transcribed recording asks for no digest and nobody is offered one. **Nothing tells an
   * open page that it changed** — in a deployment it is a restart — so open pages after it.
   */
  setting: (state: 'on' | 'off'): Promise<void> => control('PUT', `/control/setting/${state}`),
  /**
   * What the API does once as it boots, run again: asks for every digest a meeting is owed
   * — a recording transcribed while the setting was off, a digest it left out of date — and
   * resolves once each has been asked for. **It is the other half of "switched back on"**:
   * in a deployment the setting comes back with a restart and the restart catches up, and
   * `setting('on')` here is only the switch. The specs share a database, so it also asks
   * for whatever an earlier test left owed; those are answered at once, ahead of this one.
   */
  catchUp: (): Promise<void> => control('POST', '/control/catch-up'),
  /**
   * Releases every key and switches the setting back on, so no test inherits a generation
   * nobody will ever answer — or an API that generates nothing.
   */
  reset: async (): Promise<void> => {
    await Promise.all([control('DELETE', '/control/holds'), control('PUT', '/control/setting/on')]);
  },
};

export interface DigestScript {
  summary?: string;
  /** `owner` is the name as it was "spoken"; the API decides whether it is a participant. */
  actionItems?: ReadonlyArray<{ description: string; owner?: string }>;
  decisions?: ReadonlyArray<string>;
  /** The generation waits while the spec holds this key. */
  holdKey?: string;
  /** The generation fails, as Anthropic being unreachable would fail it. */
  fails?: boolean;
  /** It fails only while the spec holds this key: released, the same transcript is answered. */
  failsWhile?: string;
}

/**
 * A transcript that tells the scripted Claude what the digest of its meeting holds: the
 * directives `apps/api/test/e2e-web/digest-script.ts` reads, after a sentence of speech.
 */
export function digestTranscript(script: DigestScript): string {
  return [
    'Shall we begin.',
    ...(script.summary === undefined ? [] : [`[[digest:summary ${script.summary}]]`]),
    ...(script.actionItems ?? []).map(({ description, owner }) =>
      owner === undefined
        ? `[[digest:action ${description}]]`
        : `[[digest:action ${description} @@ ${owner}]]`,
    ),
    ...(script.decisions ?? []).map((decision) => `[[digest:decision ${decision}]]`),
    ...(script.holdKey === undefined ? [] : [`[[digest:hold ${script.holdKey}]]`]),
    ...(script.fails === true ? ['[[digest:fail]]'] : []),
    ...(script.failsWhile === undefined ? [] : [`[[digest:fail ${script.failsWhile}]]`]),
  ].join(' ');
}

/** Uploads a recording whose transcript will be `script`, through the page's own picker. */
export async function uploadRecording(
  page: Page,
  name: string,
  script: DigestScript,
): Promise<Recording> {
  const recording = recordingNamed(name);

  await transcriber.answer(recording, digestTranscript(script));
  await pickRecordings(page, [recording]);

  return recording;
}

/** The digest section. Absent from the page altogether while there is nothing to show. */
export const digestSection = (page: Page): Locator =>
  page.getByRole('region', { name: 'Digest', exact: true });

/** One of the three parts, by its heading: Summary, Action items, Decisions. */
export const digestPart = (page: Page, name: string): Locator =>
  digestSection(page).getByRole('region', { name, exact: true });

export const queuedDigest = (page: Page): Locator => digestSection(page).getByText('Digest queued');
export const generatingDigest = (page: Page): Locator =>
  digestSection(page).getByText('Generating digest…');
export const failedDigest = (page: Page): Locator => digestSection(page).getByText('Digest failed');
export const outOfDateMark = (page: Page): Locator => digestSection(page).getByText('Out of date');

/** The section's one control: another try at a digest that failed. */
export const retryDigestButton = (page: Page): Locator =>
  digestSection(page).getByRole('button', { name: 'Retry', exact: true });
/** Every button of the section: none, for a reader who may ask for nothing. */
export const digestButtons = (page: Page): Locator => digestSection(page).getByRole('button');

/**
 * Opens a meeting's page and waits until it has drawn its files and been given its digest.
 *
 * For a spec about to assert that something is **not** there. `goto` resolves at the load
 * event, before the page has asked the API for anything, and an absence asserted then is
 * true of every page: it would pass over an empty Digest card drawn a moment later.
 */
export async function openMeetingPage(page: Page, meetingId: string): Promise<void> {
  const digestAnswered = page.waitForResponse(
    (response) => response.url().endsWith(`/meetings/${meetingId}/digest`) && response.ok(),
  );

  await page.goto(`/meetings/${meetingId}`);
  await digestAnswered;
  await expect(page.getByRole('heading', { level: 2, name: 'Files' })).toBeVisible();
}

/** A digest that is simply there: its parts on the page and no status beside them. */
export async function expectCurrentDigest(page: Page): Promise<void> {
  await expect(digestPart(page, 'Summary')).toBeVisible();
  await expect(queuedDigest(page)).toBeHidden();
  await expect(generatingDigest(page)).toBeHidden();
  await expect(outOfDateMark(page)).toBeHidden();
}

export interface DigestViaApi {
  version: number;
  status?: string;
  content?: { decisions: Array<{ description: string }> };
}

/** The digest as the API answers it now, whatever any page is showing. */
export async function digestViaApi(token: string, meetingId: string): Promise<DigestViaApi> {
  const response = await fetch(`${API_URL}/meetings/${meetingId}/digest`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Reading the digest failed with ${String(response.status)}`);
  }

  return (await response.json()) as DigestViaApi;
}

const isDigestRequestUrl = (url: string): boolean => url.endsWith('/digest/generation');

/** The answer to a retry of the digest, as the page that pressed Retry receives it. */
export const isDigestRequest = (response: Response): boolean =>
  response.request().method() === 'POST' && isDigestRequestUrl(response.url());

/** The status a retry of the digest answers this user with, asked as the page would ask. */
export async function requestDigestStatusViaApi(token: string, meetingId: string): Promise<number> {
  const response = await fetch(`${API_URL}/meetings/${meetingId}/digest/generation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  return response.status;
}

/** Set on the page once it has loaded, and gone if the page is ever loaded again. */
export const markLoaded = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Object.assign(window, { e2eLoadedOnce: true });
  });
export const isStillTheSameLoad = (page: Page): Promise<boolean> =>
  page.evaluate(() => 'e2eLoadedOnce' in window);
