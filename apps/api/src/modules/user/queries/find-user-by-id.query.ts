/** Resolves to the public `User`, or `null` when no row has that id. */
export class FindUserByIdQuery {
  constructor(readonly userId: string) {}
}
