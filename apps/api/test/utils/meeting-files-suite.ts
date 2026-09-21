import http from 'node:http';

import type { Meeting } from '@repo/shared';
import request from 'supertest';

import type { ApiSuite } from './api-suite';
import { MEETINGS_URL, PASSWORD, REGISTER_URL } from './fixtures';
import { accessTokenOf, listeningPort } from './http';
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

/**
 * A request with a raw body, for the chunk route: `Content-Type` is set explicitly so the
 * module's raw parser handles it and supertest does not serialise the buffer as JSON.
 */
export function putBytes(
  suite: ApiSuite,
  url: string,
  token: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): request.Test {
  return request(suite.app().getHttpServer())
    .put(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', contentType)
    .send(bytes);
}

export interface HeadersOnlyAnswer {
  status: number;
  body: unknown;
}

/** How long a headers-only request waits before concluding the server is waiting for the body. */
const HEADERS_ONLY_DEADLINE_MS = 5_000;

/**
 * A `PUT` that declares a body of `contentLength` bytes and never sends it, so whatever comes
 * back was decided from the headers alone. A server that waits for the body answers nothing,
 * and this rejects after the deadline instead.
 *
 * **Supertest cannot ask this.** It always sends the body, and a server that answers early and
 * closes the socket fails the upload with `EPIPE` before the answer can be read.
 */
export async function putHeadersOnly(
  suite: Pick<ApiSuite, 'app'>,
  url: string,
  headers: http.OutgoingHttpHeaders,
  contentLength: number,
): Promise<HeadersOnlyAnswer> {
  const port = await listeningPort(suite.app().getHttpServer() as http.Server);

  return new Promise<HeadersOnlyAnswer>((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path: url,
        method: 'PUT',
        headers: { ...headers, 'content-length': String(contentLength) },
        // A socket of its own: this one is abandoned mid-request, and must not be pooled.
        agent: false,
      },
      (response) => {
        let text = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          outgoing.destroy();
          resolve({
            status: response.statusCode ?? 0,
            body: text === '' ? undefined : JSON.parse(text),
          });
        });
      },
    );

    outgoing.setTimeout(HEADERS_ONLY_DEADLINE_MS, () => {
      outgoing.destroy();
      reject(
        new Error(
          `No answer in ${String(HEADERS_ONLY_DEADLINE_MS)} ms: the server waited for the body`,
        ),
      );
    });
    outgoing.on('error', reject);
    outgoing.flushHeaders();
  });
}
