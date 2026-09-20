/**
 * Removing the caller's avatar. Idempotent by design: an account with none is not an error,
 * because "there is no avatar" is the state the caller asked for and already has.
 */
export class DeleteAvatarCommand {
  constructor(readonly userId: string) {}
}
