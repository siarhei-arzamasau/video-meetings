/** The most tasks one search answers with, the most similar first. */
export const TASK_SEARCH_LIMIT = 20;

/**
 * The most open tasks of one meeting that are listed at once, the oldest first. A bound at
 * all because a member's client can add tasks without limit, and the list is one answer.
 */
export const OPEN_TASKS_LIMIT = 100;

/**
 * The most tasks one owner — a user, or nobody — may have in one meeting. A bound at all
 * because a member's client can write tasks as fast as it can send them, a task cannot be
 * deleted, and every search reads the index they all sit in. Far past what a meeting is
 * ever said to need; what it stops is a loop.
 */
export const MAX_TASKS_PER_OWNER = 500;

/**
 * As long as a digest's action item may be, which is what a task is a record of. A bound at
 * all because the title is part of a unique index, and PostgreSQL refuses an index entry
 * past a third of a page.
 */
export const MAX_TASK_TITLE_LENGTH = 500;

/**
 * The fewest characters a title may have, trimmed. Under it the text is a fragment — an
 * initial, an abbreviation — and not something to be done.
 */
export const MIN_TASK_TITLE_LENGTH = 3;
