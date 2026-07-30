/**
 * The stored hash, and the id needed to issue a token for it. Nothing else.
 *
 * Declared here rather than in `@repo/shared` on purpose: that package is imported by the
 * browser bundle, and a password hash must not appear in a type the client can even name.
 * Nothing outside the login path has a use for this shape.
 */
export interface UserCredentials {
  id: string;
  passwordHash: string;
}

/**
 * The one query that deliberately returns a secret, which is why it is separate from
 * `FindUserByIdQuery` instead of a flag on it: the login path asks for credentials, and
 * every other caller gets a shape that cannot leak one.
 */
export class FindUserCredentialsByEmailQuery {
  constructor(readonly email: string) {}
}
