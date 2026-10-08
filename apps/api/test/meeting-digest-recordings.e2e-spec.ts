import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, meetingFileTranscriptionRetryUrl, meetingFileUrl } from './utils/fixtures';
import { FAILED as TRANSCRIPTION_FAILED } from './utils/meeting-file-transcription-table';
import { findMeetingDigestContentRows, findMeetingDigestRow } from './utils/meeting-digests-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { UNDECODABLE_REPLY, fixture, useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';
const THIRD = 'The pricing page has to be updated before the launch.';

/** The decisions of a digest: with the fake Claude, the transcript of each recording it read. */
const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * A digest follows the meeting's recordings: one generation at a time however they arrive,
 * out of date while one of them is not in it, and withheld once one it was built from is gone.
 */
describe('a meeting digest and the recordings it is built from', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);
  const { transcriber } = transcription;

  it('never has two generations open for a meeting: a recording transcribed meanwhile gets one more', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);

    // Two more land while the first generation is still out, and a second worker looks.
    await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.transcribe(host.token, meeting.id, THIRD);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);

    // The first answer is stored and readable, marked as not covering every recording…
    claude.release();
    await claude.arrived(2);
    const between = await digests.read(host.token, meeting.id);
    expect(between.status).toBe('generating');
    expect(decisionsOf(between)).toEqual([FIRST]);
    expect(between.content?.outOfDate).toBe(true);

    // …and the one generation that follows it covers all three.
    claude.release();
    await expect(drained).resolves.toBe(2);

    const final = await digests.read(host.token, meeting.id);
    expect(final.status).toBe('ready');
    expect(decisionsOf(final)).toEqual([FIRST, SECOND, THIRD]);
    expect(final.content?.outOfDate).toBe(false);
    expect(claude.calls).toHaveLength(2);
    expect(claude.mostOpen).toBe(1);
  });

  it("keeps a digest readable, marked out of date, until a second recording's replaces it", async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const first = await digests.read(host.token, meeting.id);

    await digests.transcribe(host.token, meeting.id, SECOND);

    const waiting = await digests.read(host.token, meeting.id);
    expect(waiting.status).toBe('queued');
    expect(waiting.content).toEqual({ ...first.content, outOfDate: true });
    expect(waiting.version).toBeGreaterThan(first.version);

    await expect(digests.worker().drain()).resolves.toBe(1);

    const replaced = await digests.read(host.token, meeting.id);
    expect(decisionsOf(replaced)).toEqual([FIRST, SECOND]);
    expect(replaced.content?.outOfDate).toBe(false);
  });

  it('stops returning a digest the moment a recording it was built from is deleted', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.worker().drain();
    expect(decisionsOf(await digests.read(host.token, meeting.id))).toEqual([FIRST, SECOND]);

    await suite
      .delete(meetingFileUrl(meeting.id, second.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);

    // Nothing has reacted to the delete: the read itself withholds what was said in it.
    const after = await digests.read(host.token, meeting.id);
    expect(after).not.toHaveProperty('content');
    expect(JSON.stringify(after)).not.toContain(SECOND);
  });

  it('generates nothing, and fails nothing, when the only recording is deleted before its digest is claimed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const only = await digests.transcribe(host.token, meeting.id, FIRST);
    await suite
      .delete(meetingFileUrl(meeting.id, only.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);

    // The claim finds no transcript to send: nothing leaves, and the meeting has no digest.
    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(claude.calls).toEqual([]);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      failure_reason: null,
      attempts: 0,
      leased_until: null,
    });
    // Requested, claimed, cleared: three writes a client was shown, and no status left.
    await expect(digests.read(host.token, meeting.id)).resolves.toEqual({
      meetingId: meeting.id,
      version: 3,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
  });

  it('leaves out a recording whose transcription failed, and takes it in once its retry succeeds', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    transcriber.reply = () => UNDECODABLE_REPLY;
    const failed = await transcription.uploadReady(host.token, meeting.id, fixture('sample.mp3'));
    await transcription.transcriptionWorker().drain();
    await digests.requested();
    await expect(findMeetingFileRow(suite.prisma(), failed.id)).resolves.toMatchObject({
      transcription_status: TRANSCRIPTION_FAILED,
    });

    // The failure holds nothing up, and asked for nothing itself: one request, one call.
    await expect(digests.worker().drain()).resolves.toBe(1);
    const without = await digests.read(host.token, meeting.id);
    expect(without.status).toBe('ready');
    expect(decisionsOf(without)).toEqual([FIRST]);
    expect(without.content?.outOfDate).toBe(false);
    expect(claude.calls).toHaveLength(1);

    transcriber.reply = () => ({ kind: 'text', text: SECOND });
    await suite
      .post(meetingFileTranscriptionRetryUrl(meeting.id, failed.id), {})
      .set('Authorization', `Bearer ${host.token}`)
      .expect(200);
    await transcription.transcriptionWorker().drain();
    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(decisionsOf(await digests.read(host.token, meeting.id))).toEqual([FIRST, SECOND]);
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      sources: expect.arrayContaining([failed.id]),
    });
  });
});
