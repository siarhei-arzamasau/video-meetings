import type { Meeting } from '@repo/shared';
import request from 'supertest';

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

/**
 * A multipart body built by hand, with the filename exactly as given.
 *
 * Supertest's `.attach` goes through `form-data`, which takes the basename of the filename
 * and percent-encodes quotes in it — the same normalisation browsers apply. That is right for
 * a client, but it means the API's own name rule cannot be exercised through it: a path
 * separator or a raw quote never arrives. This sends what a hostile or unusual client would.
 */
export function postRawMultipart(
  suite: ApiSuite,
  url: string,
  token: string,
  filename: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): request.Test {
  const boundary = 'raw-boundary-9f2c';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return request(suite.app().getHttpServer())
    .post(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
    .send(body);
}
