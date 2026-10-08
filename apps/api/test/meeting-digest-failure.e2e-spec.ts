import type { MeetingDigest, MeetingFile } from '@repo/shared';

import { ClaudeAgentFailure } from '../src/modules/claude-agent/claude-agent.constants';
import { ClaudeAgentError } from '../src/modules/claude-agent/claude-agent.error';
import { useApiSuite } from './utils/api-suite';
import {
  DIGEST_FAILED_MESSAGE,
  DIGEST_TOO_LONG_MESSAGE,
  MAX_DIGEST_TRANSCRIPT_CHARACTERS,
  digestTimeLimitMessage,
  useDigestSuite,
} from './utils/digest-suite';
import { CLAUDE_MARKER, FakeClaudeAgent } from './utils/fake-claude-agent';
import type { ClaudeReply } from './utils/fake-claude-agent';
import { EMAIL, meetingFileContentUrl, meetingFileTranscriptUrl } from './utils/fixtures';
import {
  FAILED,
  findMeetingDigestContentRows,
  findMeetingDigestRow,
} from './utils/meeting-digests-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

const failing = (failure: ClaudeAgentFailure, words: string): ClaudeReply => ({
  kind: 'error',
  error: new ClaudeAgentError(failure, `${CLAUDE_MARKER}: ${words}`, { costUsd: 0.0321 }),
});

/** Anthropic out of reach, a token it refuses, and an answer that is not a digest. */
const UNREACHABLE = failing(ClaudeAgentFailure.FAILED, 'API Error: Unable to connect to API');
const REFUSED = failing(ClaudeAgentFailure.AUTHENTICATION, 'Invalid bearer token');
const NOT_A_DIGEST: ClaudeReply = {
  kind: 'answer',
  output: { summary: CLAUDE_MARKER, actionItems: 'none', decisions: [] },
};

/** A digest in every respect but one: PostgreSQL will not store a NUL in text. */
const UNSTORABLE: ClaudeReply = {
  kind: 'answer',
  output: { summary: `Launch moved.\u0000${CLAUDE_MARKER}`, actionItems: [], decisions: [] },
};

/**
 * Every way a generation can fail ends the same way for everything that is not the digest:
 * the recordings as they were, their transcripts still served, and a digest that was already
 * stored still there. What differs is the sentence — and none of them is Anthropic's.
 */
describe('a meeting digest that fails', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  interface Scene {
    host: RegisteredUser;
    meetingId: string;
    files: MeetingFile[];
    /** The digest of the first recording, stored before anything failed. */
    stored: MeetingDigest;
  }

  /** A meeting with a digest of one recording, and a second recording whose digest is queued. */
  const withStoredDigest = async (secondTranscript = SECOND): Promise<Scene> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const stored = await digests.read(host.token, meeting.id);
    const second = await digests.transcribe(host.token, meeting.id, secondTranscript);
    claude.calls = [];

    return { host, meetingId: meeting.id, files: [first, second], stored };
  };

  /**
   * What every failure has to leave behind: the digest failed with `reason`, the content
   * stored before it untouched, both recordings as they were, and nothing of Anthropic's own
   * words anywhere a client can read.
   */
  const expectFailedAndNothingElseTouched = async (
    { host, meetingId, files, stored }: Scene,
    filesBefore: unknown[],
    reason: string,
  ): Promise<void> => {
    const row = await findMeetingDigestRow(suite.prisma(), meetingId);
    expect(row).toMatchObject({ status: FAILED, failure_reason: reason, leased_until: null });
    await expect(findMeetingDigestContentRows(suite.prisma(), meetingId)).resolves.toMatchObject({
      decisions: [FIRST],
      sources: [files[0]?.id],
    });

    const served = await digests.read(host.token, meetingId);
    expect(served).toMatchObject({ status: 'failed', failureReason: reason });
    // Still the first digest, now saying it does not cover the second recording.
    expect(served.content).toEqual({ ...stored.content, outOfDate: true });
    expect(JSON.stringify([row, served])).not.toContain(CLAUDE_MARKER);

    const filesAfter = await Promise.all(
      files.map(({ id }) => findMeetingFileRow(suite.prisma(), id)),
    );
    expect(filesAfter).toEqual(filesBefore);
    // Every recording still downloads, and its transcript still opens.
    const urls = files.flatMap(({ id }) => [
      meetingFileContentUrl(meetingId, id),
      meetingFileTranscriptUrl(meetingId, id),
    ]);
    const answers = await Promise.all(
      urls.map((url) => suite.get(url).set('Authorization', `Bearer ${host.token}`)),
    );
    expect(answers.map(({ status }) => status)).toEqual(urls.map(() => 200));
  };

  const fileRowsOf = (scene: Scene): Promise<unknown[]> =>
    Promise.all(scene.files.map(({ id }) => findMeetingFileRow(suite.prisma(), id)));

  it.each([
    ['Anthropic cannot be reached', UNREACHABLE],
    ['Anthropic refuses the token', REFUSED],
    ['the answer is not a digest', NOT_A_DIGEST],
    ['the answer cannot be stored', UNSTORABLE],
  ])('ends Failed with fixed copy when %s, and asks only once', async (_case, reply) => {
    const scene = await withStoredDigest();
    const filesBefore = await fileRowsOf(scene);
    claude.reply = () => reply;

    await expect(digests.worker().drain()).resolves.toBe(1);

    await expectFailedAndNothingElseTouched(scene, filesBefore, DIGEST_FAILED_MESSAGE);
    // One request and no more: a failure is not retried behind the user's back.
    expect(claude.calls).toHaveLength(1);
    await expect(digests.worker().drain()).resolves.toBe(0);
  });

  it('ends Failed naming the limit when a generation outruns it, and hangs up on Claude', async () => {
    const scene = await withStoredDigest();
    const filesBefore = await fileRowsOf(scene);
    digests.configure({ timeLimitSeconds: 1 });
    claude.reply = () => ({ kind: 'hold' });

    await expect(digests.worker().drain()).resolves.toBe(1);

    await expectFailedAndNothingElseTouched(scene, filesBefore, digestTimeLimitMessage('1-second'));
    expect(claude.hangUps).toBe(1);
  });

  it('ends Failed as too long, with nothing sent, when the transcripts are past the cap', async () => {
    // One character more than a request may carry, said only at the very end.
    const tooLong = `${'a'.repeat(MAX_DIGEST_TRANSCRIPT_CHARACTERS - FIRST.length)}!`;
    const scene = await withStoredDigest(tooLong);
    const filesBefore = await fileRowsOf(scene);

    await expect(digests.worker().drain()).resolves.toBe(1);

    await expectFailedAndNothingElseTouched(scene, filesBefore, DIGEST_TOO_LONG_MESSAGE);
    // Whole or not at all: no part of the meeting was sent to be passed off as all of it.
    expect(claude.calls).toEqual([]);
  });

  it('sends transcripts that are exactly at the cap', async () => {
    const atTheCap = 'a'.repeat(MAX_DIGEST_TRANSCRIPT_CHARACTERS - FIRST.length);
    const { host, meetingId } = await withStoredDigest(atTheCap);
    // Not the fake's usual digest, which quotes each transcript and would not fit an answer.
    const output = { summary: 'A very long meeting.', actionItems: [], decisions: [] };
    claude.reply = () => ({ kind: 'answer', output });

    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toHaveLength(
      MAX_DIGEST_TRANSCRIPT_CHARACTERS + '<recording number="1">\n\n</recording>'.length * 2 + 2,
    );
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({
      status: 'ready',
      content: { summary: 'A very long meeting.', outOfDate: false },
    });
  });

  it('fails a first digest with no content at all, and the recording is still transcribed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    claude.reply = () => NOT_A_DIGEST;

    await digests.worker().drain();

    // Nothing of an answer that is not a digest is stored: not its summary, not a list.
    await expect(digests.read(host.token, meeting.id)).resolves.toEqual({
      meetingId: meeting.id,
      version: 3,
      status: 'failed',
      failureReason: DIGEST_FAILED_MESSAGE,
      // The way back: there is no automatic retry.
      availableAction: 'retry',
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual({
      actionItems: [],
      decisions: [],
      sources: [],
    });
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      summary: null,
    });
  });
});
