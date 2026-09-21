export type { UserCredentials } from './user-credentials';

/**
 * The login path's read, and one of the two queries that deliberately return a secret. Kept
 * separate from `FindUserByIdQuery` rather than added to it as a flag: only the credential
 * paths ask for a hash, and every other caller gets a shape that cannot leak one.
 */
export class FindUserCredentialsByEmailQuery {
  constructor(readonly email: string) {}
}
