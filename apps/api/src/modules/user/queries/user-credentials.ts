/**
 * The stored hash, and the id needed to issue a token for it. Nothing else.
 *
 * Declared here rather than in `@repo/shared` on purpose: that package is imported by the
 * browser bundle, and a password hash must not appear in a type the client can even name.
 * Nothing outside the two credential queries has a use for this shape.
 *
 * Its own file because there are two of those queries — by email for login, by id for a
 * password change — and a shared shape that lived in one of them would make the other import
 * across a boundary that is really just "the credential queries".
 */
export interface UserCredentials {
  id: string;
  passwordHash: string;
}
