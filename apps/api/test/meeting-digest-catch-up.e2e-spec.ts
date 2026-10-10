import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { DIGEST_FAILED_MESSAGE, useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import {
  FAILED,
  GENERATING,
  QUEUED,
  findMeetingDigestContentRows,
  findMeetingDigestRow,
  setMeetingDigestState,
} from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { setMeetingFileState } from './utils/meeting-files-table';
import { fixture, useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * The catch-up: what an application does once at boot with the digest on, run here by hand.
 * Which digests it asks for — every state that nothing else will ever leave — and which it
 * leaves alone. That it asks once whoever else is asking is `meeting-digest-catch-up-races`',
 * and that a boot really runs it is `meeting-digest-catch-up-boot`'s.
 */
describe('catching up the meeting digests nothing asked for', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  const setUp = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meetingId: meeting.id };
  };

  /** Transcribes a recording with the digest off, and leaves it switched on again. */
  const transcribeWhileOff = async (
    host: RegisteredUser,
    meetingId: string,
    transcript: string,
  ): Promise<void> => {
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, transcript);
    digests.configure({ enabled: true });
  };

  it('asks for the digest of a recording transcribed while the setting was off, announced as it is queued', async () => {
    const { host, meetingId } = await setUp();
    await transcribeWhileOff(host, meetingId, FIRST);
    const stream = await digests.watch(host.token, meetingId);

    await expect(digests.catchUp()).resolves.toBe(1);

    expect(await stream.next()).toEqual({ meetingId, version: 1, status: 'queued' });
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      requested_revision: 1,
      leased_until: null,
    });
    // Asked for, not generated: the worker claims the row like any other.
    expect(claude.calls).toEqual([]);

    await expect(digests.worker().drain()).resolves.toBe(1);
    const ready = await digests.read(host.token, meetingId);
    expect(ready.status).toBe('ready');
    expect(decisionsOf(ready)).toEqual([FIRST]);
    expect(claude.calls).toHaveLength(1);
  });

  it('replaces a digest a recording left out of date, which stays readable until it is', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    await digests.worker().drain();
    await transcribeWhileOff(host, meetingId, SECOND);
    const outOfDate = await digests.read(host.token, meetingId);
    expect(outOfDate).toMatchObject({ status: 'ready', content: { outOfDate: true } });

    await expect(digests.catchUp()).resolves.toBe(1);

    await expect(digests.read(host.token, meetingId)).resolves.toEqual({
      meetingId,
      version: outOfDate.version + 1,
      status: 'queued',
      content: outOfDate.content,
    });

    await expect(digests.worker().drain()).resolves.toBe(1);
    const both = await digests.read(host.token, meetingId);
    expect(decisionsOf(both)).toEqual([FIRST, SECOND]);
    expect(both.content?.outOfDate).toBe(false);
  });

  it('asks again for a digest withheld by a delete that nothing followed', async () => {
    const { host, meetingId } = await setUp();
    const first = await digests.transcribe(host.token, meetingId, FIRST);
    const second = await digests.transcribe(host.token, meetingId, SECOND);
    await digests.worker().drain();
    // Deleted with no event: a process killed between a delete and the reaction to it.
    await setMeetingFileState(suite.prisma(), second.id, { status: 'deleted' });
    expect(await digests.read(host.token, meetingId)).not.toHaveProperty('content');

    await expect(digests.catchUp()).resolves.toBe(1);
    await expect(digests.worker().drain()).resolves.toBe(1);

    const replaced = await digests.read(host.token, meetingId);
    expect(decisionsOf(replaced)).toEqual([FIRST]);
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toMatchObject({
      sources: [first.id],
    });
  });

  it('asks for the digest a delete emptied while the setting was off', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    const second = await digests.transcribe(host.token, meetingId, SECOND);
    await digests.worker().drain();
    digests.configure({ enabled: false });
    await digests.remove(host.token, meetingId, second.id);
    digests.configure({ enabled: true });
    expect(await digests.read(host.token, meetingId)).not.toHaveProperty('status');

    await expect(digests.catchUp()).resolves.toBe(1);
    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(decisionsOf(await digests.read(host.token, meetingId))).toEqual([FIRST]);
    expect(claude.calls).toHaveLength(2);
  });

  it('catches up every meeting that is owed a digest, and no other', async () => {
    const host = await registerUser(suite, EMAIL);
    const other = await registerUser(suite, OTHER_EMAIL);
    const current = await createMeeting(suite, host);
    const owed = await createMeeting(suite, host);
    const alsoOwed = await createMeeting(suite, other);
    const withoutRecording = await createMeeting(suite, other);
    await digests.transcribe(host.token, current.id, FIRST);
    await digests.worker().drain();
    await transcribeWhileOff(host, owed.id, FIRST);
    await transcribeWhileOff(other, alsoOwed.id, SECOND);
    await transcription.uploadReady(other.token, withoutRecording.id, fixture('sample.pdf'));

    await expect(digests.catchUp()).resolves.toBe(2);

    await expect(digests.worker().drain()).resolves.toBe(2);
    expect(decisionsOf(await digests.read(host.token, owed.id))).toEqual([FIRST]);
    expect(decisionsOf(await digests.read(other.token, alsoOwed.id))).toEqual([SECOND]);
    // A file that is not a recording asks for nothing, and no row is made for its meeting.
    await expect(findMeetingDigestRow(suite.prisma(), withoutRecording.id)).resolves.toBeNull();
    expect(claude.calls).toHaveLength(3);
  });

  it('leaves a failed digest to its Retry', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    await setMeetingDigestState(suite.prisma(), meetingId, {
      status: FAILED,
      failure_reason: DIGEST_FAILED_MESSAGE,
    });

    await expect(digests.catchUp()).resolves.toBe(0);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: FAILED,
      failure_reason: DIGEST_FAILED_MESSAGE,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toEqual([]);
  });

  it('asks for nothing while a digest is queued, being generated, or current', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);

    // Queued by the recording's own request.
    await expect(digests.catchUp()).resolves.toBe(0);

    await setMeetingDigestState(suite.prisma(), meetingId, {
      status: GENERATING,
      attempts: 1,
      leased_until: new Date(Date.now() + 60_000),
    });
    await expect(digests.catchUp()).resolves.toBe(0);

    await setMeetingDigestState(suite.prisma(), meetingId, { status: QUEUED, leased_until: null });
    await digests.worker().drain();
    await expect(digests.catchUp()).resolves.toBe(0);

    // One request from first to last: the recording's, and one generation for it.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      requested_revision: 1,
    });
    expect(claude.calls).toHaveLength(1);
  });

  it('asks for nothing while the setting is off, and makes no row', async () => {
    const { host, meetingId } = await setUp();
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, FIRST);

    await expect(digests.catchUp()).resolves.toBe(0);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    expect(claude.calls).toEqual([]);
  });
});
