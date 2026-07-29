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

/** Credentials accepted by both register and login. */
export interface Credentials {
  email: string;
  password: string;
}
