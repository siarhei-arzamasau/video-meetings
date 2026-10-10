import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  DIGEST_NOT_FAILED_MESSAGE,
  DIGEST_REPEATED_FAILURE_MESSAGE,
  useDigestSuite,
} from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL, THIRD_EMAIL, meetingDigestGenerationUrl } from './utils/fixtures';
import {
  FAILED,
  QUEUED,
  READY,
  findMeetingDigestRow,
  setMeetingDigestState,
} from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const STRANGER_EMAIL = 'linus@example.com';
const FIRST = 'We decided to move the launch to the fifteenth of April.';
const NOT_FOUND = { statusCode: 404, message: 'Meeting not found' };

const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * `POST /api/meetings/:id/digest/generation` — Retry: the only way a person asks for a
 * digest, and only for one that failed. Who may send it, and what it does to a digest that
 * allows it; what it refuses is `meeting-digest-request-refusals`'. The digests nobody has
 * to ask for — a recording's, and the ones a boot catches up — are other specs'.
 */
describe('retrying a meeting digest', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  interface Scene {
    host: RegisteredUser;
    uploader: RegisteredUser;
    /** In the meeting, and the uploader of none of its recordings. */
    participant: RegisteredUser;
    /** Registered, and not in the meeting. */
    stranger: RegisteredUser;
    meetingId: string;
  }

  const setUp = async (): Promise<Scene> => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const participant = await registerUser(suite, THIRD_EMAIL);
    const stranger = await registerUser(suite, STRANGER_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id, participant.id]);

    return { host, uploader, participant, stranger, meetingId: meeting.id };
  };

  /**
   * A meeting whose one recording is the uploader's, and whose digest failed — as a fourth
   * claim leaves it, with a count that would fail the next claim unrun.
   */
  const withFailedDigest = async (): Promise<Scene> => {
    const scene = await setUp();

    await digests.transcribe(scene.uploader.token, scene.meetingId, FIRST);
    await setMeetingDigestState(suite.prisma(), scene.meetingId, {
      status: FAILED,
      attempts: 4,
      failure_reason: DIGEST_REPEATED_FAILURE_MESSAGE,
    });

    return scene;
  };

  it('offers nothing and accepts nothing for a recording transcribed while the setting was off', async () => {
    const { host, uploader, participant, meetingId } = await setUp();
    digests.configure({ enabled: false });
    await digests.transcribe(uploader.token, meetingId, FIRST);
    digests.configure({ enabled: true });

    // Owed a digest, and nobody's to ask for: the next boot's catch-up asks.
    const owed = { meetingId, version: 0 };
    await expect(digests.read(host.token, meetingId)).resolves.toEqual(owed);
    await expect(digests.read(participant.token, meetingId)).resolves.toEqual(owed);

    const responses = await Promise.all([
      digests.ask(host.token, meetingId).expect(409),
      digests.ask(uploader.token, meetingId).expect(409),
    ]);

    for (const { body } of responses) {
      expect(body).toMatchObject({ statusCode: 409, message: DIGEST_NOT_FAILED_MESSAGE });
    }
    // Refused without a row being made for the refusal.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toEqual([]);
  });

  it('retries a failed digest for the host and for the uploader, the claim count back at 0', async () => {
    const { host, uploader, participant, meetingId } = await withFailedDigest();
    const failed = await digests.read(participant.token, meetingId);
    expect(failed).toEqual({
      meetingId,
      version: 1,
      status: 'failed',
      failureReason: DIGEST_REPEATED_FAILURE_MESSAGE,
      availableAction: 'retry',
    });
    const stream = await digests.watch(participant.token, meetingId);

    await digests.ask(participant.token, meetingId).expect(404);
    const response = await digests.ask(uploader.token, meetingId).expect(200);

    // The digest as the request left it: queued, with nothing further to ask for.
    const queued = { meetingId, version: 2, status: 'queued' };
    expect(response.body).toEqual(queued);
    expect(await stream.next()).toEqual(queued);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      failure_reason: null,
      requested_revision: 2,
      leased_until: null,
    });
    expect(claude.calls).toEqual([]);

    await expect(digests.worker().drain()).resolves.toBe(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      attempts: 1,
      failure_reason: null,
    });

    // A generation that fails again is the host's to retry as well.
    await setMeetingDigestState(suite.prisma(), meetingId, { status: FAILED });
    await digests.ask(host.token, meetingId).expect(200);
    await expect(digests.worker().drain()).resolves.toBe(1);
    const ready = await digests.read(host.token, meetingId);
    expect(ready.status).toBe('ready');
    expect(decisionsOf(ready)).toEqual([FIRST]);
    expect(ready).not.toHaveProperty('failureReason');
    expect(ready).not.toHaveProperty('availableAction');
  });

  it('answers 404 to another participant and to a stranger, and writes nothing', async () => {
    const { participant, stranger, meetingId } = await withFailedDigest();
    const before = await findMeetingDigestRow(suite.prisma(), meetingId);

    const responses = await Promise.all([
      digests.ask(participant.token, meetingId).expect(404),
      digests.ask(stranger.token, meetingId).expect(404),
    ]);

    // One 404 for both, and the one a meeting that does not exist gets.
    expect(responses.map(({ body }) => body as unknown)).toEqual([
      expect.objectContaining(NOT_FOUND),
      expect.objectContaining(NOT_FOUND),
    ]);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toEqual(before);
    await expect(digests.worker().drain()).resolves.toBe(0);

    // And the same with the setting off: what a deployment generates is not theirs to learn.
    digests.configure({ enabled: false });
    await digests.ask(participant.token, meetingId).expect(404);
    await digests.ask(stranger.token, meetingId).expect(404);
  });

  it('answers 401 without a token and 400 for an id that is not one, before any meeting is looked for', async () => {
    const { host, meetingId } = await withFailedDigest();

    await suite.post(meetingDigestGenerationUrl(meetingId), {}).expect(401);
    await digests.ask(host.token, 'not-a-uuid').expect(400);
  });
});
