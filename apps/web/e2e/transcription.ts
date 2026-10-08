import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page, Response } from '@playwright/test';
import { expect } from '@playwright/test';

import { API_URL } from './fixtures';

/** Where `playwright.config.ts` starts `fake-transcriber.mjs`, restated as that file states it. */
const TRANSCRIBER_URL = 'http://127.0.0.1:3102';

const SAMPLE_MP3 = path.join(__dirname, 'fixtures', 'sample.mp3');

/**
 * The failure copy from `@repo/shared`, restated for the reason `fixtures.ts` restates every
 * other sentence: rewording it must fail a spec rather than quietly pass it.
 */
export const TRANSCRIPTION_FAILED_MESSAGE = 'The recording could not be transcribed.';

/**
 * Words only the endpoint says. Nothing the page shows about a failure may contain them: the
 * reason a user reads is the API's own fixed copy, and Whisper's stays in the server log.
 */
export const ENDPOINT_MARKER = 'whisper-internal-marker-7f3a';

export interface Recording {
  /** What the fake transcriber recognises these bytes by. */
  marker: string;
  /** What `setInputFiles` takes. */
  file: { name: string; mimeType: string; buffer: Buffer };
}

/**
 * An MP3 the API accepts, unlike any other: the fixture followed by a marker of its own.
 *
 * The API uploads every recording to the transcriber as `recording.mp3`, so the name cannot
 * tell two of them apart and the bytes have to. The marker trails the audio, where the type
 * check — which reads the head — never looks.
 */
export function recordingNamed(name: string): Recording {
  const marker = `e2e-recording-${randomUUID()}`;
  const buffer = Buffer.concat([fs.readFileSync(SAMPLE_MP3), Buffer.from(marker, 'latin1')]);

  return { marker, file: { name, mimeType: 'audio/mpeg', buffer } };
}

type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'error'; status: number; body: string }
  | { kind: 'hold' };

async function control(method: 'PUT' | 'DELETE', body?: unknown): Promise<void> {
  const response = await fetch(`${TRANSCRIBER_URL}/control/replies`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  if (response.status !== 204) {
    throw new Error(`The fake transcriber answered ${String(response.status)} to ${method}`);
  }
}

const reply = ({ marker }: Recording, to: Reply): Promise<void> =>
  control('PUT', { marker, reply: to });

/**
 * The spec's handle on the fake Whisper. A reply set before the upload decides what the
 * recording gets; one set while it is being held settles the request that is waiting.
 */
export const transcriber = {
  /** No answer until `answer` or `fail`: the row stays on "Transcribing…" meanwhile. */
  hold: (recording: Recording): Promise<void> => reply(recording, { kind: 'hold' }),
  answer: (recording: Recording, text: string): Promise<void> =>
    reply(recording, { kind: 'text', text }),
  /** A 500 whose body carries `ENDPOINT_MARKER`, as a server that fell over would send. */
  fail: (recording: Recording): Promise<void> =>
    reply(recording, {
      kind: 'error',
      status: 500,
      body: JSON.stringify({ detail: `Model crashed while decoding. ${ENDPOINT_MARKER}` }),
    }),
  /** Forgets every reply and answers whatever is still held, so no test inherits a wait. */
  reset: (): Promise<void> => control('DELETE'),
};

/** The row for a file, by name. Rows are list items inside the Files list. */
export const rowFor = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

export const queuedChip = (row: Locator): Locator => row.getByText('Queued for transcription');
export const transcribingChip = (row: Locator): Locator => row.getByText('Transcribing…');
export const failedChip = (row: Locator): Locator => row.getByText('Transcription failed');
export const transcriptLink = (row: Locator): Locator =>
  row.getByRole('link', { name: 'Open transcript' });
/** The row's one Retry. On a recording that is ready, it is the transcription's. */
export const retryButton = (row: Locator): Locator => row.getByRole('button', { name: 'Retry' });

export const pickRecordings = (page: Page, recordings: Recording[]): Promise<void> =>
  page.locator('input[type="file"]').setInputFiles(recordings.map(({ file }) => file));

/** Presses Download on a row and resolves to the bytes the browser was handed. */
export async function downloadFrom(page: Page, row: Locator): Promise<Buffer> {
  const downloading = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Download' }).click();

  return fs.readFileSync(await (await downloading).path());
}

/**
 * Presses "Open transcript" and resolves to the tab it opened, once that tab is showing a
 * document rather than the blank page it starts as.
 */
export async function openTranscript(page: Page, row: Locator): Promise<Page> {
  const opening = page.waitForEvent('popup');
  await transcriptLink(row).click();
  const tab = await opening;

  await expect(tab).toHaveURL(/^blob:/);

  return tab;
}

/** The answer to the transcription retry route, as the page that pressed Retry receives it. */
export const isTranscriptionRetry = (response: Response): boolean =>
  response.request().method() === 'POST' && response.url().endsWith('/transcription/retry');

/** A recording's transcription status as the API lists it now, whatever any page is showing. */
export async function transcriptionStatusViaApi(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<string | undefined> {
  const response = await fetch(`${API_URL}/meetings/${meetingId}/files`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const files = (await response.json()) as Array<{ id: string; transcriptionStatus?: string }>;

  return files.find(({ id }) => id === fileId)?.transcriptionStatus;
}

/** The transcription retry route's status for one file, asked as the signed-in user would. */
export async function retryTranscriptionStatusViaApi(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<number> {
  const response = await fetch(
    `${API_URL}/meetings/${meetingId}/files/${fileId}/transcription/retry`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );

  return response.status;
}

/** The transcript route's status for one file, asked as the signed-in user would. */
export async function transcriptStatusViaApi(
  token: string,
  meetingId: string,
  fileId: string,
): Promise<number> {
  const response = await fetch(`${API_URL}/meetings/${meetingId}/files/${fileId}/transcript`, {
    headers: { authorization: `Bearer ${token}` },
  });

  return response.status;
}
