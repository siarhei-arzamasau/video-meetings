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
