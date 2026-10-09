/** The most tasks one search answers with, the most similar first. */
export const TASK_SEARCH_LIMIT = 20;

/**
 * As long as a digest's action item may be, which is what a task is a record of. A bound at
 * all because the title is half of a unique index, and PostgreSQL refuses an index entry
 * past a third of a page.
 */
export const MAX_TASK_TITLE_LENGTH = 500;

/**
 * The fewest characters a title may have, trimmed. Under it the text is a fragment — an
 * initial, an abbreviation — and not something to be done.
 */
export const MIN_TASK_TITLE_LENGTH = 3;
