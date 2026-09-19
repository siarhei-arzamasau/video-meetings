import type { Meeting } from '@repo/shared';

import type { ApiSuite } from './api-suite';
import { MEETINGS_URL, PASSWORD, REGISTER_URL } from './fixtures';
import { accessTokenOf } from './http';
import { findUserRow } from './users-table';

export interface RegisteredUser {
  id: string;
  token: string;
}

/** Signs up an account through the API and reads its id back from the table. */
export async function registerUser(suite: ApiSuite, email: string): Promise<RegisteredUser> {
  const response = await suite.post(REGISTER_URL, { email, password: PASSWORD }).expect(201);
  const user = await findUserRow(suite.prisma(), email);

  return { id: user.id, token: accessTokenOf(response) };
}

/** Creates a meeting through the API, hosted by `host`, with the given participants. */
export async function createMeeting(
  suite: ApiSuite,
  host: RegisteredUser,
  participantIds: string[] = [],
  title = 'Engine review',
): Promise<Meeting> {
  const response = await suite
    .post(MEETINGS_URL, {
      title,
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      participantIds,
    })
    .set('Authorization', `Bearer ${host.token}`)
    .expect(201);

  return response.body as Meeting;
}
