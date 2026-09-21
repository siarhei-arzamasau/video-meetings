/**
 * What register and login return.
 *
 * The token is the whole response: there is no user object alongside it, so a client that
 * needs the current user asks for it. That makes the JWT payload part of the client-facing
 * contract rather than an internal detail.
 */
export interface AuthResponse {
  /** A signed JWT. `sub` is the user's id. */
  accessToken: string;
}

/** The email-and-password pair the auth endpoints validate. The web app's registration client
 *  sends exactly this; the API destructures it into command primitives. */
export interface Credentials {
  email: string;
  password: string;
}

/*
 * The bounds below are shared so the browser can reject what the API would reject anyway.
 * The API stays the authority — `RegisterDto` enforces them, and the client's check only
 * saves a round trip. Relaxing a bound here relaxes it on the server too, which is the point:
 * a second copy in the web app would drift, and the drift would only ever show up as a 400
 * the form said could not happen.
 */

/** Longest address RFC 5321 permits. Bounds the column and the work done validating it. */
export const MAX_EMAIL_LENGTH = 254;

export const MIN_PASSWORD_LENGTH = 8;

/** A ceiling on hashing work, not a security rule — argon2 costs time per byte. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Body of `PATCH /api/auth/password`.
 *
 * No `email` and no user id: the endpoint acts on whoever the token names. Proving the
 * current password is what authorises the change — a valid token alone is not enough, because
 * a token read out of `localStorage` by someone at a borrowed keyboard would otherwise be a
 * licence to lock the owner out.
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/**
 * What a wrong current password says, on both sides of the wire.
 *
 * It is shared for a reason beyond the usual one. The API answers a wrong current password
 * with **401**, the shape a failed login has, so the endpoint reveals no more than login
 * does — and the browser already treats a 401 as "the token went bad, sign out". The two are
 * told apart by this exact sentence, so the constant is not copy: it is the discriminator.
 * Rewording it in one place and not the other would sign a user out for a typo.
 */
export const CURRENT_PASSWORD_MESSAGE = 'That is not your current password.';

/**
 * Rejecting a "change" that changes nothing. A 400, not a 401: the caller proved the current
 * password to get here, so there is nothing left to be coy about.
 */
export const PASSWORD_UNCHANGED_MESSAGE =
  'Your new password must be different from your current one.';

/** What a confirmation that does not match the new password says. Checked in the browser
 *  only — the API is never sent a confirmation, because it has nothing to compare it against
 *  that the browser did not already have. */
export const PASSWORD_MISMATCH_MESSAGE = 'The two passwords do not match.';
