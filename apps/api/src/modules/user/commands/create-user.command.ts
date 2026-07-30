/**
 * Carries the hash, never the password. argon2 and the password policy belong to the auth
 * module, and a raw credential should not cross a module boundary merely to be stored — this
 * module could not tell a well-hashed password from a badly-hashed one and has no business
 * trying.
 */
export class CreateUserCommand {
  constructor(
    readonly email: string,
    readonly passwordHash: string,
  ) {}
}
