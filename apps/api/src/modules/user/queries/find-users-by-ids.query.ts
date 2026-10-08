/**
 * What one user is called, and which user that is. Nothing else — and in particular no
 * email address: this is the one shape in which a user's name reaches somebody who is not
 * that user, so it is declared here, beside the only query that returns it, rather than
 * cut out of the public `User` at each call site.
 */
export interface UserDisplayName {
  id: string;
  displayName: string;
}

/**
 * Resolves to the current display name of each of `userIds` that is a user, in no promised
 * order. An id that names nobody is simply not in the answer — the plural of the query
 * rule that a miss is `null` and what it means is the caller's.
 *
 * **It carries no asker and checks nothing about one.** Whether these names may be shown to
 * whoever the caller is answering is the caller's to have decided, as it is for
 * `FindUserByIdQuery`: a route that dispatches this with ids its caller chose has published
 * every user's name.
 */
export class FindUsersByIdsQuery {
  constructor(readonly userIds: ReadonlyArray<string>) {}
}
