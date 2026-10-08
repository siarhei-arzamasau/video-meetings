import type { INestApplication } from '@nestjs/common';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import {
  DIGEST_REPEATED_FAILURE_MESSAGE,
  configureDigest,
  digestWorkerOf,
  useDigestSuite,
} from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, meetingDigestUrl } from './utils/fixtures';
import {
  FAILED,
  GENERATING,
  QUEUED,
  READY,
  findMeetingDigestRow,
  setMeetingDigestState,
} from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const MINUTE_MS = 60_000;
const TRANSCRIPT = 'We decided to move the launch to the fifteenth of April.';

/**
 * What happens to a generation when the thing doing it goes away: a process that shuts down
 * and a process that dies. Neither may leave a digest in Generating for ever, only repeated
 * deaths may fail one — and a process that only reads a digest never asks Claude for it.
 */
describe('a meeting digest that is interrupted', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);
  /** Second applications a test started and has not yet shut down itself. */
  const replicas: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(replicas.splice(0).map((replica) => replica.close()));
  });

  /** A second API over the same database, with a Claude of its own to count calls on. */
  const startReplica = async (): Promise<{ app: INestApplication; claude: FakeClaudeAgent }> => {
    const replicaClaude = new FakeClaudeAgent();
    const app = await createTestApp({ overrides: [replicaClaude.override()] });

    replicas.push(app);
    configureDigest(app);

    return { app, claude: replicaClaude };
  };

  const queuedDigest = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, TRANSCRIPT);

    return { host, meetingId: meeting.id };
  };

  /** The claim a worker that died left behind: generating, counted, its lease as given. */
  const abandonClaim = (
    meetingId: string,
    attempts: number,
    leaseEndsInMs: number,
  ): Promise<void> =>
    setMeetingDigestState(suite.prisma(), meetingId, {
      status: GENERATING,
      attempts,
      leased_until: new Date(Date.now() + leaseEndsInMs),
    });

  it('hands the claim back on a graceful shutdown, and another process finishes it', async () => {
    const { host, meetingId } = await queuedDigest();
    const replica = await startReplica();
    replica.claude.reply = () => ({ kind: 'hold' });

    const drained = digestWorkerOf(replica.app).drain();
    await replica.claude.arrived(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: GENERATING,
      attempts: 1,
    });

    await replicas.pop()?.close();
    await expect(drained).resolves.toBe(1);

    // Queued again, not failed and not counted: no number of deploys can fail a digest.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
      failure_reason: null,
    });
    expect(replica.claude.hangUps).toBe(1);

    await expect(digests.worker().drain()).resolves.toBe(1);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      attempts: 1,
    });
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({ status: 'ready' });
  });

  it('reclaims a generation whose worker died, once its lease has lapsed', async () => {
    const { meetingId } = await queuedDigest();
    await abandonClaim(meetingId, 1, MINUTE_MS);

    // The lease still stands: for all anyone knows, that worker is alive and working.
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toEqual([]);

    await abandonClaim(meetingId, 1, -MINUTE_MS);
    await expect(digests.worker().drain()).resolves.toBe(1);

    // A crash counts, unlike a shutdown: this was the second claim.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      attempts: 2,
      leased_until: null,
    });
  });

  it('fails a digest claimed a fourth time without sending anything', async () => {
    const { host, meetingId } = await queuedDigest();
    await abandonClaim(meetingId, 3, -MINUTE_MS);

    await expect(digests.worker().drain()).resolves.toBe(1);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: FAILED,
      failure_reason: DIGEST_REPEATED_FAILURE_MESSAGE,
      attempts: 4,
      leased_until: null,
    });
    expect(claude.calls).toEqual([]);
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'failed',
      failureReason: DIGEST_REPEATED_FAILURE_MESSAGE,
    });
  });

  it('keeps its lease while a generation outlasts it, so no second worker starts one', async () => {
    const { meetingId } = await queuedDigest();
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    const claimed = await findMeetingDigestRow(suite.prisma(), meetingId);

    // Longer than the run's five second lease: only the heartbeat keeps the claim alive.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const replica = await startReplica();
    await expect(digestWorkerOf(replica.app).drain()).resolves.toBe(0);
    const renewed = await findMeetingDigestRow(suite.prisma(), meetingId);
    expect(Date.parse(renewed?.leased_until ?? '')).toBeGreaterThan(
      Date.parse(claimed?.leased_until ?? ''),
    );
    // A renewal is not something a client is shown.
    expect(renewed?.version).toBe(claimed?.version);

    claude.release();
    await expect(drained).resolves.toBe(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      attempts: 1,
    });
    expect(replica.claude.calls).toEqual([]);
  }, 15_000);

  it('serves a stored digest from a second process with no request to Claude', async () => {
    const { host, meetingId } = await queuedDigest();
    await digests.worker().drain();
    const stored = await digests.read(host.token, meetingId);
    claude.calls = [];

    // A process that has just started — a restart, or a second replica — over the same rows.
    const replica = await startReplica();
    const { default: request } = await import('supertest');
    const response = await request(replica.app.getHttpServer())
      .get(meetingDigestUrl(meetingId))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);

    expect(response.body).toEqual(stored);
    await expect(digestWorkerOf(replica.app).drain()).resolves.toBe(0);
    expect(replica.claude.calls).toEqual([]);
    expect(claude.calls).toEqual([]);
  });
});
