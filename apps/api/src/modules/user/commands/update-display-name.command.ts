/**
 * Carries the id of the user to rename, which is always the caller: the controller reads it
 * from what the guard attached, never from the path or the body. Nothing outside this module
 * is in a position to hand it a different one, and no route offers the chance.
 *
 * The name is the value as it arrived. Trimming belongs to the handler, not to the caller —
 * a command has to be safe whatever dispatched it, so the rule cannot live only in the DTO
 * that happens to run before the one caller there is today.
 */
export class UpdateDisplayNameCommand {
  constructor(
    readonly userId: string,
    readonly displayName: string,
  ) {}
}
