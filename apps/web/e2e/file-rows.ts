import type { Locator, Page } from '@playwright/test';

/**
 * What only the row of a listed file says: who added it — "added by you", or "added by a
 * member". Restated for the reason `fixtures.ts` restates every other sentence.
 */
const ADDED_BY = 'added by';

/** Every row of the Files list under a name: the list holds uploads as well as files. */
const rowsNamed = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: name });

/**
 * The row of a file the meeting has, by name.
 *
 * **The listed file's row, and never the row of the upload that made it.** The Files list
 * draws both, and for a moment after an upload both are on the page under one name: the
 * stream delivers the file while the request that sent it is still unanswered, and the
 * upload's row only goes with that answer. A locator by name alone resolves to two elements
 * for those few milliseconds, and strict mode fails whatever was being asserted — which it
 * did, about one run of the suite in four, wherever a spec looked at a row straight after an
 * upload.
 *
 * Still strict among files: two listed rows of one name are a failure, as they should be.
 * That is what a `.first()` here would have hidden.
 */
export const rowFor = (page: Page, name: string): Locator =>
  rowsNamed(page, name).filter({ hasText: ADDED_BY });

/**
 * The row of an upload, by the name of its file: in flight, with its progress and Cancel,
 * or failed before it ever became a file, with its reason and Dismiss. It is gone once the
 * upload is answered — the file's own row, `rowFor`, is another element.
 */
export const uploadRowFor = (page: Page, name: string): Locator =>
  rowsNamed(page, name).filter({ hasNotText: ADDED_BY });
