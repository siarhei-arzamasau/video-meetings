/**
 * Carries a hash, never a password — the same rule `CreateUserCommand` states, for the same
 * reason: argon2 and the password policy belong to the auth module, and this module could not
 * tell a well-hashed password from a badly-hashed one.
 *
 * The id is always the caller's. The controller reads it from what the guard attached, and no
 * route offers the chance to name anybody else.
 */
export class UpdatePasswordHashCommand {
  constructor(
    readonly userId: string,
    readonly passwordHash: string,
  ) {}
}
