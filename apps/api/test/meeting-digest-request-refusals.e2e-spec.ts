import { useApiSuite } from './utils/api-suite';
import {
  DIGEST_CURRENT_MESSAGE,
  DIGEST_NOT_FAILED_MESSAGE,
  DIGEST_NO_RECORDING_MESSAGE,
  DIGEST_SWITCHED_OFF_MESSAGE,
  DIGEST_UNDER_WAY_MESSAGE,
  useDigestSuite,
} from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
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
import { setMeetingFileState } from './utils/meeting-files-table';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

/**
 * What the retry route refuses, each with a 409 that changes nothing: a request is a paid
 * generation, and one for a digest that is current, queued, or generating would be a second
 * one for the same recordings — while one for a digest that is owed and has not failed is
 * the boot's catch-up's to make, and no person's. Wherever it is refused the read offers no
 * action, and the two are one rule (`requestabilityFor`, as a retry).
 */
describe('a retry of a meeting digest that is refused', () => {
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
    await digests.catchUp();
    await digests.worker().drain();
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'failed',
      availableAction: 'retry',
    });
    digests.configure({ enabled: false });

    await expectRefused(host, meetingId, DIGEST_SWITCHED_OFF_MESSAGE);
    expect(claude.calls).toHaveLength(1);
  });

  it('refuses a digest that is owed and has not failed, and makes no row for the refusal', async () => {
    const { host, meetingId } = await setUp();
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, FIRST);
    digests.configure({ enabled: true });

    // No digest, and a recording to build one from: the catch-up's to ask for.
    await expectRefused(host, meetingId, DIGEST_NOT_FAILED_MESSAGE);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();

    // Out of date with nothing queued: readable, marked, and still nobody's to ask for.
    await digests.catchUp();
    await digests.worker().drain();
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, SECOND);
    digests.configure({ enabled: true });
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'ready',
      content: { outOfDate: true },
    });

    await expectRefused(host, meetingId, DIGEST_NOT_FAILED_MESSAGE);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it('refuses a meeting with no transcribed recording, a failed digest of one included', async () => {
    const { host, meetingId } = await setUp();

    await expectRefused(host, meetingId, DIGEST_NO_RECORDING_MESSAGE);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();

    // A digest that failed, and whose one recording was then deleted with nothing reacting:
    // the row still says failed, and there is nothing left to retry it from.
    const file = await digests.transcribe(host.token, meetingId, FIRST);
    await setMeetingDigestState(suite.prisma(), meetingId, { status: FAILED });
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'failed',
      availableAction: 'retry',
    });
    await setMeetingFileState(suite.prisma(), file.id, { status: 'deleted' });

    // The offer is gone under the version it was made at: nothing was written for it to move.
    await expectRefused(host, meetingId, DIGEST_NO_RECORDING_MESSAGE);
  });

  it('accepts one of three retries made at once, for one generation', async () => {
    const host = await registerUser(suite, EMAIL);
    const uploader = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [uploader.id]);
    await digests.transcribe(uploader.token, meeting.id, FIRST);
    await setMeetingDigestState(suite.prisma(), meeting.id, { status: FAILED });

    const responses = await Promise.all([
      digests.ask(host.token, meeting.id),
      digests.ask(uploader.token, meeting.id),
      digests.ask(host.token, meeting.id),
    ]);

    // The first to take the row's lock asks; the other two find it queued.
    expect(responses.map(({ status }) => status).toSorted()).toEqual([200, 409, 409]);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 2,
      version: 2,
    });
    await expect(digests.worker().drain()).resolves.toBe(1);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });
});
