import { useApiSuite } from './utils/api-suite';
import {
  DIGEST_CURRENT_MESSAGE,
  DIGEST_NO_RECORDING_MESSAGE,
  DIGEST_SWITCHED_OFF_MESSAGE,
  DIGEST_UNDER_WAY_MESSAGE,
  useDigestSuite,
} from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { GENERATING, QUEUED, READY, findMeetingDigestRow } from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

/**
 * What "generate now" refuses, each with a 409 that changes nothing: a request is a paid
 * generation, and one for a digest that is current, queued, or generating would be a second
 * one for the same recordings. Wherever it is refused the read offers no action, and the
 * two are one rule (`requestabilityOf`).
 */
describe('a request for a meeting digest that is refused', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  const setUp = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meetingId: meeting.id };
  };

  /** A 409 carrying `message`, after which the row is exactly what it was before. */
  const expectRefused = async (
    host: RegisteredUser,
    meetingId: string,
    message: string,
  ): Promise<void> => {
    const before = await findMeetingDigestRow(suite.prisma(), meetingId);
    await expect(digests.read(host.token, meetingId)).resolves.not.toHaveProperty(
      'availableAction',
    );

    const response = await digests.ask(host.token, meetingId).expect(409);

    expect(response.body).toMatchObject({ statusCode: 409, message });
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toEqual(before);
  };

  it('refuses a digest that covers every transcribed recording', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    await digests.worker().drain();

    await expectRefused(host, meetingId, DIGEST_CURRENT_MESSAGE);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it('refuses a digest that is queued', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);

    await expectRefused(host, meetingId, DIGEST_UNDER_WAY_MESSAGE);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 1,
    });
  });

  it('refuses a digest that is generating, and the generation under way is the only one', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: GENERATING,
    });

    await expectRefused(host, meetingId, DIGEST_UNDER_WAY_MESSAGE);

    claude.release();
    await drained;
    // Ready, not queued again: a refused request moved no revision.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
    expect(claude.mostOpen).toBe(1);
  });

  it('refuses everything while the setting is off, a failed digest included', async () => {
    const { host, meetingId } = await setUp();
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, FIRST);

    await expectRefused(host, meetingId, DIGEST_SWITCHED_OFF_MESSAGE);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();

    // A digest that failed while it was on is not retried while it is off.
    digests.configure({ enabled: true });
    claude.reply = () => ({ kind: 'error', error: new Error('unreachable') });
    await digests.ask(host.token, meetingId).expect(200);
    await digests.worker().drain();
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'failed',
      availableAction: 'retry',
    });
    digests.configure({ enabled: false });

    await expectRefused(host, meetingId, DIGEST_SWITCHED_OFF_MESSAGE);
    expect(claude.calls).toHaveLength(1);
  });

  it('refuses a meeting with no transcribed recording, and makes no row for it', async () => {
    const { host, meetingId } = await setUp();

    await expectRefused(host, meetingId, DIGEST_NO_RECORDING_MESSAGE);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();

    // Offered while there is a recording, and gone with it — under the version it was
    // offered at: a meeting with no digest has none to move, and a delete makes no row.
    digests.configure({ enabled: false });
    const file = await digests.transcribe(host.token, meetingId, FIRST);
    digests.configure({ enabled: true });
    const offered = { meetingId, version: 0, availableAction: 'generate' };
    await expect(digests.read(host.token, meetingId)).resolves.toEqual(offered);
    await digests.remove(host.token, meetingId, file.id);

    await expect(digests.read(host.token, meetingId)).resolves.toEqual({ meetingId, version: 0 });
    await expectRefused(host, meetingId, DIGEST_NO_RECORDING_MESSAGE);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
  });

  it('accepts one of two requests made at once, for one generation', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id]);
    digests.configure({ enabled: false });
    await digests.transcribe(uploader.token, meeting.id, FIRST);
    await digests.transcribe(host.token, meeting.id, SECOND);
    digests.configure({ enabled: true });

    // No row yet, so there is nothing for either to find locked: the hardest case.
    const responses = await Promise.all([
      digests.ask(host.token, meeting.id),
      digests.ask(uploader.token, meeting.id),
      digests.ask(host.token, meeting.id),
    ]);

    expect(responses.map(({ status }) => status).toSorted()).toEqual([200, 409, 409]);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 1,
      version: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(1);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });
});
