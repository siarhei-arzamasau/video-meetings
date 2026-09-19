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
 * One byte over the cap, generated into the OS temp directory rather than checked in. Sparse
 * where the filesystem allows it; a full write of 100 MB otherwise, once per run.
 */
export function oversizedFile(): string {
  const file = path.join(os.tmpdir(), 'meeting-files-e2e-oversized.bin');

  if (!fs.existsSync(file) || fs.statSync(file).size !== MAX_MEETING_FILE_SIZE_BYTES + 1) {
    const handle = fs.openSync(file, 'w');
    fs.ftruncateSync(handle, MAX_MEETING_FILE_SIZE_BYTES + 1);
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
