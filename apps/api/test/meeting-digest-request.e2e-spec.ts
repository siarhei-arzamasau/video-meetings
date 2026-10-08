import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { DIGEST_REPEATED_FAILURE_MESSAGE, useDigestSuite } from './utils/digest-suite';
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
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';
const NOT_FOUND = { statusCode: 404, message: 'Meeting not found' };

const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * `POST /api/meetings/:id/digest/generation` — Generate and Retry, one request: the only
 * way a digest is asked for that no recording caused. Who may send it, and what it does to
 * a digest that allows it; what it refuses is `meeting-digest-request-refusals`'.
 */
describe('asking for a meeting digest', () => {
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

  /** A meeting whose one recording, the uploader's, was transcribed with the digest off. */
  const withRecordingTranscribedWhileOff = async (): Promise<Scene> => {
    const scene = await setUp();

    digests.configure({ enabled: false });
    await digests.transcribe(scene.uploader.token, scene.meetingId, FIRST);
    digests.configure({ enabled: true });

    return scene;
  };

  it('starts nothing for a recording transcribed while the setting was off, and offers Generate', async () => {
    const scene = await setUp();
    const { host, uploader, participant, meetingId } = scene;
    digests.configure({ enabled: false });
    await digests.transcribe(uploader.token, meetingId, FIRST);

    // Off: no digest, and nothing to ask for.
    await expect(digests.read(host.token, meetingId)).resolves.toEqual({ meetingId, version: 0 });

    digests.configure({ enabled: true });

    await expect(digests.worker().drain()).resolves.toBe(0);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    expect(claude.calls).toEqual([]);
    // The same answer for everyone who can read it: whether this reader may ask is the
    // route's to enforce, and the page's to work out from the files it holds.
    const offered = { meetingId, version: 0, availableAction: 'generate' };
    await expect(digests.read(host.token, meetingId)).resolves.toEqual(offered);
    await expect(digests.read(participant.token, meetingId)).resolves.toEqual(offered);
  });

  it.each([
    ['the host', 'host'],
    ['the uploader of the transcribed recording', 'uploader'],
  ] as const)('generates a digest when %s asks, announced as it is queued', async (_who, role) => {
    const scene = await withRecordingTranscribedWhileOff();
    const { meetingId } = scene;
    const stream = await digests.watch(scene.participant.token, meetingId);

    const response = await digests.ask(scene[role].token, meetingId).expect(200);

    // The digest as the request left it: queued, and nothing further to ask for.
    const queued = { meetingId, version: 1, status: 'queued' };
    expect(response.body).toEqual(queued);
    expect(await stream.next()).toEqual(queued);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      requested_revision: 1,
      leased_until: null,
    });
    expect(claude.calls).toEqual([]);

    await expect(digests.worker().drain()).resolves.toBe(1);

    const ready = await digests.read(scene.host.token, meetingId);
    expect(ready.status).toBe('ready');
    expect(decisionsOf(ready)).toEqual([FIRST]);
    expect(ready).not.toHaveProperty('availableAction');
    expect(claude.calls).toHaveLength(1);
  });

  it('answers 404 to another participant and to a stranger, and writes nothing', async () => {
    const { participant, stranger, meetingId } = await withRecordingTranscribedWhileOff();

    const responses = await Promise.all([
      digests.ask(participant.token, meetingId).expect(404),
      digests.ask(stranger.token, meetingId).expect(404),
    ]);

    // One 404 for both, and the one a meeting that does not exist gets.
    expect(responses.map(({ body }) => body as unknown)).toEqual([
      expect.objectContaining(NOT_FOUND),
      expect.objectContaining(NOT_FOUND),
    ]);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    await expect(digests.worker().drain()).resolves.toBe(0);

    // And the same with the setting off: what a deployment generates is not theirs to learn.
    digests.configure({ enabled: false });
    await digests.ask(participant.token, meetingId).expect(404);
    await digests.ask(stranger.token, meetingId).expect(404);
  });

  it('answers 401 without a token and 400 for an id that is not one, before any meeting is looked for', async () => {
    const { host, meetingId } = await withRecordingTranscribedWhileOff();

    await suite.post(meetingDigestGenerationUrl(meetingId), {}).expect(401);
    await digests.ask(host.token, 'not-a-uuid').expect(400);
  });

  it('retries a failed digest for the host and for the uploader, the claim count back at 0', async () => {
    const { host, uploader, participant, meetingId } = await setUp();
    await digests.transcribe(uploader.token, meetingId, FIRST);
    // Failed as a fourth claim leaves it: a count that would fail the next claim unrun.
    await setMeetingDigestState(suite.prisma(), meetingId, {
      status: FAILED,
      attempts: 4,
      failure_reason: DIGEST_REPEATED_FAILURE_MESSAGE,
    });
    const failed = await digests.read(participant.token, meetingId);
    expect(failed).toEqual({
      meetingId,
      version: 1,
      status: 'failed',
      failureReason: DIGEST_REPEATED_FAILURE_MESSAGE,
      availableAction: 'retry',
    });

    await digests.ask(participant.token, meetingId).expect(404);
    const response = await digests.ask(uploader.token, meetingId).expect(200);

    expect(response.body).toEqual({ meetingId, version: 2, status: 'queued' });
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      failure_reason: null,
      requested_revision: 2,
    });

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
  });

  it('accepts the request for a digest that is out of date with nothing queued', async () => {
    const { host, uploader, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    await digests.worker().drain();
    digests.configure({ enabled: false });
    await digests.transcribe(uploader.token, meetingId, SECOND);
    digests.configure({ enabled: true });

    // Ready, readable, marked — and nothing will ever pick the second recording up unasked.
    const outOfDate = await digests.read(host.token, meetingId);
    expect(outOfDate).toMatchObject({
      status: 'ready',
      content: { outOfDate: true },
      availableAction: 'generate',
    });
    await expect(digests.worker().drain()).resolves.toBe(0);

    // The uploader of the recording it lacks may ask, as the host may.
    const response = await digests.ask(uploader.token, meetingId).expect(200);

    // The stored digest stays readable beside the status of its replacement.
    expect(response.body).toEqual({
      meetingId,
      version: outOfDate.version + 1,
      status: 'queued',
      content: outOfDate.content,
    });

    await expect(digests.worker().drain()).resolves.toBe(1);
    const both = await digests.read(host.token, meetingId);
    expect(decisionsOf(both)).toEqual([FIRST, SECOND]);
    expect(both.content?.outOfDate).toBe(false);
    expect(both).not.toHaveProperty('availableAction');
  });
});
