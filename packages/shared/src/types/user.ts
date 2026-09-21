/** A person who can host or join meetings. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  /**
   * Present only when the user has an avatar; a relative API path, as `MeetingFile`'s
   * `thumbnailPath` is. Its absence is how a client knows to draw initials instead.
   *
   * The path carries no version, and does not need to: the response is `no-store`, so the
   * browser holds no copy to bust. See `avatarVersion` for what the number is actually for.
   */
  avatarPath?: string;
  /**
   * Bumped every time the avatar changes, including when it is removed. `0` for an account
   * that has never had one.
   *
   * It exists because the avatar is fetched with a bearer token into a blob rather than by an
   * `<img src>`, so nothing about the URL changes when the image does. A client keys its fetch
   * on this number, and a replaced avatar therefore appears without a reload.
   */
  avatarVersion: number;
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

/** Code points, after trimming — so a blank or whitespace-only name fails on this. */
export const MIN_DISPLAY_NAME_LENGTH = 1;

/** Code points, after trimming. Long enough for any real name, short enough to render in a
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
 * The one test of a display name's length, for every layer that checks it: trimmed, then
 * counted in Unicode code points, so an emoji or a CJK extension character is one character
 * however many UTF-16 code units it takes. A function rather than just the bounds because the
 * counting is the part that drifted — the DTO's `@Length` counted one way (validator.js also
 * discounts variation selectors), the handler's `.length` another, and a name that passed the
 * first was refused by the second with a message saying it was too long. Code points are also
 * what Postgres counts, should the `TEXT` column ever become a `varchar(n)`.
 *
 * Takes the untrimmed name and trims it itself, so no caller can measure the padding.
 */
export function isDisplayNameWithinBounds(displayName: string): boolean {
  const length = Array.from(displayName.trim()).length;

  return length >= MIN_DISPLAY_NAME_LENGTH && length <= MAX_DISPLAY_NAME_LENGTH;
}

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
