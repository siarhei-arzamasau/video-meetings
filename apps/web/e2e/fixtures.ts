import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Where `playwright.config.ts` puts the API. The web app is told the same URL. */
export const API_URL = 'http://localhost:3101/api';

/** The key `src/lib/auth-token.ts` stores the JWT under. Restated so the harness pins it. */
const TOKEN_KEY = 'video-meetings.access-token';

export const PASSWORD = 'correct-horse-battery-42';

const FIXTURES = path.join(__dirname, 'fixtures');

export const SAMPLE_PNG = path.join(FIXTURES, 'sample.png');
export const SAMPLE_PDF = path.join(FIXTURES, 'sample.pdf');
export const PAGE_HTML = path.join(FIXTURES, 'page.html');
export const NOTES_TXT = path.join(FIXTURES, 'notes.txt');

/** Restated, as the API fixtures restate it: a relaxed bound must fail a test. */
export const MAX_MEETING_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Restated from `@repo/shared` for the same reason, and the message with them: the edit form
 * and the API both render this sentence from one constant, so a spec that spelt it out of
 * that constant could not notice the day the copy changes under the user.
 *
 * The dash is an en dash, as the shared constant builds it.
 */
export const MAX_DISPLAY_NAME_LENGTH = 80;
export const DISPLAY_NAME_MESSAGE = 'Your display name must be 1–80 characters.';

export const MAX_CHUNKED_MEETING_FILE_SIZE_BYTES = 1024 ** 3;
export const MEETING_FILE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/** 150 MB — over the single-request cap, so the app must send it in chunks. */
export const LARGE_FILE_BYTES = 150 * 1024 * 1024;

/**
 * One byte over the size a client rejects outright — the **chunked** cap, since Phase 2.3:
 * anything between the two caps is uploaded in chunks rather than refused. Sparse, and under
 * an accepted extension so it is the size that is being tested and not the type.
 */
export function oversizedFile(): string {
  return sparsePdf('meeting-files-e2e-oversized.pdf', MAX_CHUNKED_MEETING_FILE_SIZE_BYTES + 1);
}

/**
 * A sparse file of `size` bytes that the server will accept.
 *
 * It opens with a real PDF header: the API sniffs the assembled bytes, and 150 MB of zeros is
 * no type it stores. Everything after the header is a hole, so this costs no disk and is
 * written once per run.
 */
export function sparsePdf(name: string, size: number): string {
  const file = path.join(os.tmpdir(), name);

  if (!fs.existsSync(file) || fs.statSync(file).size !== size) {
    const handle = fs.openSync(file, 'w');
    fs.writeSync(handle, Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
    fs.ftruncateSync(handle, size);
    fs.closeSync(handle);
  }

  return file;
}

export function uniqueEmail(): string {
  return `e2e-${randomUUID()}@example.com`;
}

export interface SignedInUser {
  context: BrowserContext;
  page: Page;
  email: string;
  token: string;
  userId: string;
}

/**
 * Signs up through the real form, then follows the card's link to `/`. The token is read back
 * from `localStorage` because that is where the app keeps it; nothing here signs one itself.
 */
export async function registerThroughUi(page: Page, email: string): Promise<string> {
  await page.goto('/auth/register');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText("You're all set")).toBeVisible();

  const token = await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY);

  if (token === null) {
    throw new Error('Registration finished but no token was stored');
  }

  return token;
}

/** A fresh browser context signed up as a new account, so tests can hold several users at once. */
export async function signUp(browser: Browser): Promise<SignedInUser> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail();
  const token = await registerThroughUi(page, email);

  return { context, page, email, token, userId: subjectOf(token) };
}

/** The `sub` claim, which is the user id. Decoded, not verified — the API did that. */
export function subjectOf(token: string): string {
  const [, payload] = token.split('.');

  if (payload === undefined) {
    throw new Error('Not a JWT');
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub?: unknown;
  };

  if (typeof claims.sub !== 'string') {
    throw new Error('The token carries no subject');
  }

  return claims.sub;
}

export interface CreatedMeeting {
  id: string;
  title: string;
  scheduledAt: string;
}

/** There is no create-meeting page yet, so meetings come straight from the API. */
export async function createMeetingViaApi(
  token: string,
  { title, participantIds = [] }: { title: string; participantIds?: string[] },
): Promise<CreatedMeeting> {
  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const response = await fetch(`${API_URL}/meetings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, scheduledAt, participantIds }),
  });

  if (response.status !== 201) {
    throw new Error(
      `Creating a meeting failed with ${String(response.status)}: ${await response.text()}`,
    );
  }

  const { id } = (await response.json()) as { id: string };

  return { id, title, scheduledAt };
}

/**
 * Where `@repo/api`'s `start:e2e-web` script puts uploads. Restated from that script rather
 * than read from it — the two must agree, and a spec that reads the object it just uploaded
 * is the thing that notices when they stop agreeing.
 */
export function meetingFilesDir(): string {
  return path.join(process.env['TMPDIR'] ?? '/tmp', 'meeting-files-e2e-web');
}

/** The object of one file, at the key the API derives: `<meetingId>/<fileId>`. */
export function objectPathOf(meetingId: string, fileId: string): string {
  return path.join(meetingFilesDir(), meetingId, fileId);
}

/**
 * A PNG the server stores and the preview step cannot read: header and trailer intact, so
 * `file-type` still calls it `image/png` and it is exactly as long as the real thing, and
 * everything between zeroed, so `sharp` fails on it.
 *
 * Same length as `SAMPLE_PNG` on purpose: the verify step compares the object against the
 * size on the record, so writing the real bytes over this one later repairs the file rather
 * than replacing it with one the record no longer describes. That is what lets a spec fail a
 * file, retry it into failing again, and then retry it into `ready`.
 */
export function brokenPng(): Buffer {
  const broken = Buffer.from(fs.readFileSync(SAMPLE_PNG));
  broken.fill(0, 40, broken.length - 12);

  return broken;
}

export interface ListedFile {
  id: string;
  name: string;
  status: string;
}

/** The meeting's files as the API lists them, for the spec that needs a file's id on disk. */
export async function listMeetingFilesViaApi(
  token: string,
  meetingId: string,
): Promise<ListedFile[]> {
  const response = await fetch(`${API_URL}/meetings/${meetingId}/files`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Listing files failed with ${String(response.status)}`);
  }

  return (await response.json()) as ListedFile[];
}

/**
 * Sets the display name through the API the browser will use for it.
 *
 * The edit page does not exist yet, and a spec about the profile should not be the thing that
 * waits for it: a name the user chose is what separates the rendered profile from the one
 * registration derived, and it is one request away.
 */
export async function setDisplayNameViaApi(token: string, displayName: string): Promise<void> {
  const response = await fetch(`${API_URL}/users/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName }),
  });

  if (!response.ok) {
    throw new Error(
      `Setting the display name failed with ${String(response.status)}: ${await response.text()}`,
    );
  }
}
