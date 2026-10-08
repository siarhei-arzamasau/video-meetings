import type { MeetingDigest } from '@repo/shared';

import { MeetingDigestClaimRepository } from '../src/modules/meeting-digests/services/meeting-digest-claim.repository';
import { useApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent, digestOf } from './utils/fake-claude-agent';
import { EMAIL } from './utils/fixtures';
import {
  GENERATING,
  QUEUED,
  findMeetingDigestContentRows,
  findMeetingDigestRow,
  setMeetingDigestState,
} from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

const NOTHING_STORED = { actionItems: [], decisions: [], sources: [] };

/** The decisions of a digest: with the fake Claude, the transcript of each recording it read. */
const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * A delete beside the worker: a recording deleted while Claude is writing a digest of it,
 * and a delete whose reaction never ran, found by the claim instead.
 */
describe('a meeting digest when a recording is deleted under a generation', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  afterEach(() => jest.restoreAllMocks());

  it('never stores the answer of a generation one of whose recordings was deleted while it ran', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    expect(claude.calls[0]?.prompt).toContain(SECOND);

    await digests.remove(host.token, meeting.id, second.id);

    // Claude answers with a digest of both. It is discarded, and the claim goes back
    // uncounted: the generation that follows is the first claim of its own.
    claude.release();
    await claude.arrived(2);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: GENERATING,
      attempts: 1,
      summary: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    expect(JSON.stringify(await digests.read(host.token, meeting.id))).not.toContain(SECOND);
    expect(claude.calls[1]?.prompt).not.toContain(SECOND);

    claude.release();
    await expect(drained).resolves.toBe(2);

    const final = await digests.read(host.token, meeting.id);
    expect(final.status).toBe('ready');
    expect(decisionsOf(final)).toEqual([FIRST]);
    expect(claude.mostOpen).toBe(1);
  });

  it('removes an answer whose recording was deleted, and the delete followed, between the worker’s look and its write', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    // The one order no hold on Claude can produce: the answer has passed the look at its
    // recordings, and the delete commits and is followed — finding nothing of the answer to
    // remove — before the write that stores it.
    const claims = suite.app().get(MeetingDigestClaimRepository);
    const store = claims.complete.bind(claims);
    jest.spyOn(claims, 'complete').mockImplementationOnce(async (held, content) => {
      await digests.remove(host.token, meeting.id, second.id);

      return store(held, content);
    });

    // Stored, found to name a deleted recording by the look after the write, removed, and
    // generated again from the recording that is left.
    await expect(digests.worker().drain()).resolves.toBe(2);

    const final = await digests.read(host.token, meeting.id);
    expect(final.status).toBe('ready');
    expect(decisionsOf(final)).toEqual([FIRST]);
    expect(final.content?.outOfDate).toBe(false);
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      decisions: [FIRST],
      sources: [first.id],
    });
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[0]?.prompt).toContain(SECOND);
    expect(claude.calls[1]?.prompt).not.toContain(SECOND);
  });

  it('ends a generation with no digest when the last recording is deleted while it ran', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const only = await digests.transcribe(host.token, meeting.id, FIRST);
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);

    await digests.remove(host.token, meeting.id, only.id);

    // No status the moment the recording is gone, not when the call it interrupted ends.
    await expect(digests.read(host.token, meeting.id)).resolves.not.toHaveProperty('status');

    claude.release();
    await expect(drained).resolves.toBe(1);

    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      attempts: 0,
      leased_until: null,
      summary: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    expect(claude.calls).toHaveLength(1);
  });

  it('clears a queued digest at its claim when nothing reacted to the delete of its only recording', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const only = await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.remove(host.token, meeting.id, only.id);
    // The state of a process killed between the delete and its reaction to it.
    await setMeetingDigestState(suite.prisma(), meeting.id, { status: QUEUED });

    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(claude.calls).toEqual([]);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      failure_reason: null,
      attempts: 0,
      leased_until: null,
    });
    await expect(digests.read(host.token, meeting.id)).resolves.not.toHaveProperty('status');
    await expect(digests.worker().drain()).resolves.toBe(0);
  });

  it('sends the edges that take a generation back to the queue, or to no digest, each under a higher version', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const stream = await digests.watch(host.token, meeting.id);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    expect(await stream.next()).toMatchObject({ status: 'queued' });
    expect(await stream.next()).toMatchObject({ status: 'queued' });

    // generating → queued: the answer was discarded for a recording deleted meanwhile.
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    expect(await stream.next()).toMatchObject({ status: 'generating' });
    await digests.remove(host.token, meeting.id, second.id);
    claude.reply = (request) => ({ kind: 'answer', output: digestOf(request.prompt) });
    claude.release();
    const handedBack = await stream.next();
    expect(handedBack).toEqual({
      meetingId: meeting.id,
      version: handedBack.version,
      status: 'queued',
    });
    expect(await stream.next()).toMatchObject({ status: 'generating' });
    expect(decisionsOf(await stream.next())).toEqual([FIRST]);
    await expect(drained).resolves.toBe(2);

    // generating → (none): a claim that found no recording, its delete never reacted to.
    await digests.remove(host.token, meeting.id, first.id);
    expect(await stream.next()).not.toHaveProperty('status');
    await setMeetingDigestState(suite.prisma(), meeting.id, { status: QUEUED });
    await digests.worker().drain();
    expect(await stream.next()).toMatchObject({ status: 'generating' });
    const cleared = await stream.next();
    expect(cleared).toEqual({ meetingId: meeting.id, version: cleared.version });
  });

  it('sends a generation overtaken by a second recording as queued again, its answer kept and out of date', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const stream = await digests.watch(host.token, meeting.id);
    await digests.transcribe(host.token, meeting.id, FIRST);
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    expect(await stream.next()).toMatchObject({ status: 'queued' });
    expect(await stream.next()).toMatchObject({ status: 'generating' });

    // The request changes no status, and is announced all the same: the version moved.
    await digests.transcribe(host.token, meeting.id, SECOND);
    expect(await stream.next()).toEqual({
      meetingId: meeting.id,
      version: expect.any(Number),
      status: 'generating',
    });

    claude.reply = (request) => ({ kind: 'answer', output: digestOf(request.prompt) });
    claude.release();
    const overtaken = await stream.next();
    expect(overtaken.status).toBe('queued');
    expect(decisionsOf(overtaken)).toEqual([FIRST]);
    expect(overtaken.content?.outOfDate).toBe(true);
    expect(await stream.next()).toMatchObject({ status: 'generating' });
    const both = await stream.next();
    expect(decisionsOf(both)).toEqual([FIRST, SECOND]);
    expect(both.content?.outOfDate).toBe(false);
    await expect(drained).resolves.toBe(2);
  });
});
