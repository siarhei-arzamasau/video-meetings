import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { DIGEST_FAILED_MESSAGE, useDigestSuite } from './utils/digest-suite';
import {
  CLAUDE_MARKER,
  FAKE_COST_USD,
  FAKE_MODEL,
  FakeClaudeAgent,
  digestOf,
} from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL } from './utils/fixtures';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { fixture, useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

/** The decisions of a digest: with the fake Claude, the transcript of each recording it read. */
const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * The digest on the files stream: a second event name on `GET …/files/events`, sent after
 * every committed write to a digest and carrying the digest as `GET …/digest` answers it.
 */
describe('a meeting digest on the files stream', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  it('sends every edge of a digest as it is taken, each under a higher version', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const stream = await digests.watch(host.token, meeting.id);
    const next = (): Promise<MeetingDigest> => stream.next();

    // (none) → queued: a recording was transcribed.
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    expect(await next()).toEqual({ meetingId: meeting.id, version: 1, status: 'queued' });

    // queued → generating, announced while Claude is still out.
    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);
    expect(await next()).toEqual({ meetingId: meeting.id, version: 2, status: 'generating' });

    // generating → ready: the event is the digest, not a hint to fetch it.
    claude.release();
    await drained;
    const ready = await next();
    expect(ready.status).toBe('ready');
    expect(decisionsOf(ready)).toEqual([FIRST]);
    expect(ready).toEqual(await digests.read(host.token, meeting.id));

    // ready → queued: a second recording, and the stored digest says it does not cover it.
    claude.reply = (request) => ({ kind: 'answer', output: digestOf(request.prompt) });
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    const outOfDate = await next();
    expect(outOfDate.status).toBe('queued');
    expect(outOfDate.content).toEqual({ ...ready.content, outOfDate: true });

    await digests.worker().drain();
    expect(await next()).toMatchObject({ status: 'generating', content: { outOfDate: true } });
    const both = await next();
    expect(both.status).toBe('ready');
    expect(decisionsOf(both)).toEqual([FIRST, SECOND]);
    expect(both.content?.outOfDate).toBe(false);

    // ready → queued, the content withdrawn in the same write: one of the two was deleted.
    await digests.remove(host.token, meeting.id, second.id);
    const withdrawn = await next();
    expect(withdrawn).toEqual({
      meetingId: meeting.id,
      version: withdrawn.version,
      status: 'queued',
    });

    await digests.worker().drain();
    expect(await next()).toMatchObject({ status: 'generating' });
    expect(decisionsOf(await next())).toEqual([FIRST]);

    // any → (none): the last one was deleted, and the meeting has no digest.
    await digests.remove(host.token, meeting.id, first.id);
    const gone = await next();
    expect(gone).toEqual({ meetingId: meeting.id, version: gone.version });
    expect(gone).toEqual(await digests.read(host.token, meeting.id));
  });

  it('sends a failure with its reason, and nothing of what caused it or what it cost', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const stream = await digests.watch(host.token, meeting.id);
    await digests.transcribe(host.token, meeting.id, FIRST);
    claude.reply = () => ({ kind: 'error', error: new Error(`${CLAUDE_MARKER}: overloaded`) });

    await digests.worker().drain();

    expect(await stream.next()).toMatchObject({ status: 'queued' });
    expect(await stream.next()).toMatchObject({ status: 'generating' });
    const failed = await stream.next();
    expect(failed).toEqual({
      meetingId: meeting.id,
      version: failed.version,
      status: 'failed',
      failureReason: DIGEST_FAILED_MESSAGE,
    });

    // And a generation that succeeds says what it holds, not what it took.
    claude.reply = (request) => ({ kind: 'answer', output: digestOf(request.prompt) });
    await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.worker().drain();
    await stream.next();
    await stream.next();
    const sent = JSON.stringify(await stream.next());
    for (const unsent of ['cost', String(FAKE_COST_USD), FAKE_MODEL, 'Tokens', 'attempts']) {
      expect(sent).not.toContain(unsent);
    }
    expect(sent).not.toContain(CLAUDE_MARKER);
  });

  it('says a stored digest is out of date when a recording is transcribed with the setting off', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const current = await digests.read(host.token, meeting.id);
    digests.configure({ enabled: false });
    const stream = await digests.watch(host.token, meeting.id);

    await digests.transcribe(host.token, meeting.id, SECOND);

    // Nothing is queued, so the status is the one it had; what changed is `outOfDate`, and
    // the version with it, or a page would have no way to prefer this over what it holds.
    const marked = await stream.next();
    expect(marked.status).toBe('ready');
    expect(marked.content).toEqual({ ...current.content, outOfDate: true });
    expect(marked.version).toBeGreaterThan(current.version);
    expect(marked).toEqual(await digests.read(host.token, meeting.id));
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it('sends a withdrawal with the setting off, and nothing for a meeting that never had a digest', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    digests.configure({ enabled: false });
    const stream = await digests.watch(host.token, meeting.id);

    await digests.remove(host.token, meeting.id, first.id);

    const gone = await stream.next();
    expect(gone).toEqual({ meetingId: meeting.id, version: gone.version });

    // A meeting whose recordings were all transcribed with the setting off has no row to
    // announce: its stream says nothing about a digest, whatever happens to its files.
    const other = await createMeeting(suite, host);
    const quiet = await digests.watch(host.token, other.id);
    const recording = await digests.transcribe(host.token, other.id, SECOND);
    await digests.remove(host.token, other.id, recording.id);
    await quiet.quiet();
  });

  it('sends a digest to every stream of its meeting, a participant’s included, and to no other meeting’s', async () => {
    const host = await registerUser(suite, EMAIL);
    const guest = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [guest.id]);
    const elsewhere = await createMeeting(suite, host);
    const asHost = await digests.watch(host.token, meeting.id);
    const asGuest = await digests.watch(guest.token, meeting.id);
    const other = await digests.watch(host.token, elsewhere.id);

    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();

    const seenByHost = [await asHost.next(), await asHost.next(), await asHost.next()];
    const seenByGuest = [await asGuest.next(), await asGuest.next(), await asGuest.next()];
    expect(seenByHost.map(({ status }) => status)).toEqual(['queued', 'generating', 'ready']);
    expect(seenByGuest).toEqual(seenByHost);
    await other.quiet();
  });

  it('sends nothing about a digest for a file that is not a recording', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const stream = await digests.watch(host.token, meeting.id);

    const document = await transcription.uploadReady(host.token, meeting.id, fixture('sample.pdf'));
    await transcription.transcriptionWorker().drain();
    await digests.remove(host.token, meeting.id, document.id);

    await stream.quiet();
  });
});
