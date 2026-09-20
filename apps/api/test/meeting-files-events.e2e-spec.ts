import path from 'node:path';

import { ConfigService } from '@nestjs/config';
import type { MeetingFile } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import {
  EMAIL,
  MEETINGS_URL,
  MEETING_FILE_WORKER_TOKEN,
  OTHER_EMAIL,
  THIRD_EMAIL,
  meetingFileEventsUrl,
  meetingFileUrl,
  meetingFilesUrl,
} from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { openSse } from './utils/sse';
import type { SseClient } from './utils/sse';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => path.join(FIXTURES, name);

/** The one handle the spec needs; by token, so nothing from the module is imported. */
interface WorkerHandle {
  drain(): Promise<number>;
}

/** The `MeetingFile` the next `file` event carried, skipping any heartbeat before it. */
const fileOf = async (client: SseClient): Promise<MeetingFile> =>
  JSON.parse((await client.nextOf('file')).data) as MeetingFile;

describe('GET /api/meetings/:id/files/events', () => {
  const suite = useApiSuite();
  const open: SseClient[] = [];

  const worker = (): WorkerHandle => suite.app().get<WorkerHandle>(MEETING_FILE_WORKER_TOKEN);
  const config = (): ConfigService => suite.app().get(ConfigService);

  /** Opens a stream and registers it for teardown, so no test leaves a connection behind. */
  const watch = async (token: string, meetingId: string): Promise<SseClient> => {
    const client = await openSse(suite, meetingFileEventsUrl(meetingId), token);
    open.push(client);

    return client;
  };

  const upload = async (token: string, meetingId: string, file = 'sample.png') => {
    const response = await suite
      .postFile(meetingFilesUrl(meetingId), token, fixture(file))
      .expect(201);

    return response.body as MeetingFile;
  };

  beforeEach(() => {
    // The service asks `ConfigService` per stream, which is what lets this spec shorten the
    // TTL for one test without rebuilding the application.
    config().set('MEETING_FILES_STREAM_TTL_SECONDS', 300);
  });

  afterEach(() => {
    for (const client of open.splice(0)) {
      client.close();
    }
  });

  it('opens as text/event-stream and says so before anything has happened', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const client = await watch(host.token, meeting.id);

    expect(client.status).toBe(200);
    expect(client.headers['content-type']).toContain('text/event-stream');
    // A proxy that buffers would defeat the whole route; Nest sets this, and the contract
    // is worth pinning here rather than trusting.
    expect(client.headers['x-accel-buffering']).toBe('no');
    expect(client.headers['cache-control']).toContain('no-store');
  });

  it('carries an upload, then processing and ready in that order', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const client = await watch(host.token, meeting.id);

    const uploaded = await upload(host.token, meeting.id);

    // The whole `MeetingFile`, not a diff: the client replaces the row by id.
    expect(await fileOf(client)).toEqual(uploaded);

    await expect(worker().drain()).resolves.toBe(1);

    const processing = await fileOf(client);
    const ready = await fileOf(client);

    expect(processing).toMatchObject({ id: uploaded.id, status: 'processing' });
    // The events the worker sends are built from the claimed row, so a column `claimNext`
    // forgets to return is `undefined` rather than `null` and `toMeetingFile` turns it into
    // a path. A PNG has no transcript, and the stream must not say it has.
    expect(processing.transcriptPath).toBeUndefined();
    expect(ready.transcriptPath).toBeUndefined();
    expect(ready).toMatchObject({
      id: uploaded.id,
      status: 'ready',
      thumbnailPath: `/meetings/${meeting.id}/files/${uploaded.id}/thumbnail`,
    });
  });

  it('carries a delete as a `deleted` file', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const client = await watch(host.token, meeting.id);
    const uploaded = await upload(host.token, meeting.id);

    await expect(fileOf(client)).resolves.toMatchObject({ status: 'uploaded' });

    await suite
      .delete(meetingFileUrl(meeting.id, uploaded.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);

    // `deleted` is what tells the page to take the row out of its list.
    expect(await fileOf(client)).toMatchObject({ id: uploaded.id, status: 'deleted' });
  });

  it('reaches a participant as well as the host', async () => {
    const host = await registerUser(suite, EMAIL);
    const guest = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [guest.id]);
    const client = await watch(guest.token, meeting.id);

    const uploaded = await upload(host.token, meeting.id);

    expect(await fileOf(client)).toEqual(uploaded);
  });

  it('is scoped to its meeting: another meeting`s change never arrives', async () => {
    const host = await registerUser(suite, EMAIL);
    const a = await createMeeting(suite, host, [], 'Meeting A');
    const b = await createMeeting(suite, host, [], 'Meeting B');
    const client = await watch(host.token, a.id);

    await upload(host.token, b.id);
    const mine = await upload(host.token, a.id);

    // The first file event on A's stream is A's own upload. B's came first in time and is
    // not here, which is the assertion — waiting for "nothing" any other way is a sleep.
    expect(await fileOf(client)).toEqual(mine);
  });

  it('answers a stranger with 404 and the standard error body, opening no stream', async () => {
    const host = await registerUser(suite, EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host);

    const client = await watch(stranger.token, meeting.id);

    expect(client.status).toBe(404);
    expect(JSON.parse(client.body)).toMatchObject({
      statusCode: 404,
      message: 'Meeting not found',
    });
  });

  it('answers 400 for a malformed meeting id, not an open stream', async () => {
    const host = await registerUser(suite, EMAIL);

    const client = await openSse(suite, `${MEETINGS_URL}/not-a-uuid/files/events`, host.token);
    open.push(client);

    // The guard leaves a malformed id to `ParseUUIDPipe`, whose throw is synchronous and so
    // reaches the filter before Nest commits the stream's headers.
    expect(client.status).toBe(400);
  });

  it('answers 401 without a token', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    const client = await watch('not-a-token', meeting.id);

    expect(client.status).toBe(401);
  });

  it('beats as soon as it opens, so a client need not wait 15 seconds to know it is alive', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const client = await watch(host.token, meeting.id);

    const first = await client.next();

    expect(first.type).toBe('ping');
    expect(first.data).toBe('');
  });

  it('closes itself once the TTL has passed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    config().set('MEETING_FILES_STREAM_TTL_SECONDS', 2);

    const client = await watch(host.token, meeting.id);
    await client.ended();

    expect(client.isEnded()).toBe(true);
  });

  it('shuts the application down cleanly with a stream open', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    // A second application, because this one has to be closed while a stream is held open
    // and the suite's own is closed in `afterAll`.
    const other = await createTestApp();
    const client = await openSse(
      { app: () => other },
      meetingFileEventsUrl(meeting.id),
      host.token,
    );

    expect(client.status).toBe(200);

    // The assertion is that this resolves at all: a stream that outlived the process would
    // be an open handle, and an open handle is what keeps Jest running after the last test.
    await other.close();

    await client.ended();
    expect(client.isEnded()).toBe(true);
  });
});
