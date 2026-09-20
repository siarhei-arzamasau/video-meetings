/** A person who can host or join meetings. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

/*
 * Display name bounds, shared for the same reason the email and password bounds in
 * `./auth` are: the API stays the authority and the browser's copy of the rule only saves
 * a round trip. They live here rather than next to those because a display name is a
 * property of the user record, not of the credentials that created it — the same split the
 * API makes between its `auth` and `user` modules.
 *
 * Both bounds apply to the *trimmed* name, and they bind only a name the user sets.
 * Registration still derives the initial one from the email's local part and nothing else
 * overwrites a name the user has chosen; the maximum is comfortably above the 64 characters
 * RFC 5321 allows there, so a derived name can never start out in violation of a bound the
 * user never saw.
 */

/** Characters, after trimming — so a blank or whitespace-only name fails on this. */
export const MIN_DISPLAY_NAME_LENGTH = 1;

/** Characters, after trimming. Long enough for any real name, short enough to render in a
 *  header without wrapping. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * One message for every way a name can be rejected — blank, whitespace-only, or over-long.
 * Splitting it would tell the form's author to explain the difference between a name that
 * is empty and one that is only spaces, which is a distinction the user cannot act on
 * differently. Built from the bounds above so raising one cannot leave the copy stale.
 */
export const DISPLAY_NAME_MESSAGE = `Your display name must be ${MIN_DISPLAY_NAME_LENGTH}–${MAX_DISPLAY_NAME_LENGTH} characters.`;

/**
 * Body of `PATCH /api/users/me`.
 *
 * The field name matches `User` for the same reason `CreateMeetingRequest`'s do: the request
 * and the response describe one resource. There is no `id` — the endpoint acts on whoever the
 * token names, and a caller that could address a user would be a caller that could address
 * someone else's.
 *
 * The name is sent as typed; the API trims it and answers with the trimmed value.
 */
export interface UpdateDisplayNameRequest {
  displayName: string;
}
