export type { UserCredentials } from './user-credentials';

/**
 * The same secret as `FindUserCredentialsByEmailQuery`, addressed the way an authenticated
 * request already knows the caller: by the id the token carried.
 *
 * A separate query rather than an `email` the change-password handler would first have to
 * look up. The address is not the identity here — the token's `sub` is — and asking by email
 * would mean auth holding a user's address in order to verify their password, which is one
 * more thing crossing the boundary than the job needs.
 */
export class FindUserCredentialsByIdQuery {
  constructor(readonly userId: string) {}
}
