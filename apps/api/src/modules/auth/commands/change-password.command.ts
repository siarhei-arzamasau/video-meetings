/**
 * Carries the caller's id and both raw passwords, which is the one place in this codebase a
 * raw password travels on a command — and it stays inside the auth module, which owns argon2
 * and the password policy. What crosses the boundary to `user` afterwards is a hash.
 *
 * The id comes from the token by way of the guard. No route accepts one, so nothing outside
 * this module is in a position to dispatch this for somebody else.
 */
export class ChangePasswordCommand {
  constructor(
    readonly userId: string,
    readonly currentPassword: string,
    readonly newPassword: string,
  ) {}
}
