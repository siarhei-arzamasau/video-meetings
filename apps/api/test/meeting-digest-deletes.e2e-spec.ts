import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, meetingFileUrl } from './utils/fixtures';
import {
  QUEUED,
  findMeetingDigestContentRows,
  findMeetingDigestRow,
} from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { setMeetingFileState } from './utils/meeting-files-table';
import { fixture, useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

const NOTHING_STORED = { actionItems: [], decisions: [], sources: [] };

/** The decisions of a digest: with the fake Claude, the transcript of each recording it read. */
const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

/**
 * A digest follows a deleted recording: what was built from it is withdrawn and removed, a
 * replacement is generated from what remains, and a meeting left with no transcribed
 * recording has no digest at all. What a delete does to a generation that is under way is
 * `meeting-digest-delete-races.e2e-spec.ts`'s.
 */
describe('a meeting digest when one of its recordings is deleted', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  it('withdraws the digest at once when one of two recordings is deleted, and builds the replacement from the other alone', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.worker().drain();
    const before = await digests.read(host.token, meeting.id);
    expect(decisionsOf(before)).toEqual([FIRST, SECOND]);

    // At once: the very next read, whether or not anything has reacted to the delete yet.
    await suite
      .delete(meetingFileUrl(meeting.id, second.id))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(204);
    const atOnce = await digests.read(host.token, meeting.id);
    expect(atOnce).not.toHaveProperty('content');
    expect(JSON.stringify(atOnce)).not.toContain(SECOND);

    // Then the reaction: what was built from it is gone from the tables, not only withheld,
    // and a replacement is queued as a generation of its own.
    await digests.requested();
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      failure_reason: null,
      summary: null,
      generated_at: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    const queued = await digests.read(host.token, meeting.id);
    expect(queued).toEqual({ meetingId: meeting.id, version: queued.version, status: 'queued' });
    expect(queued.version).toBeGreaterThan(before.version);

    await expect(digests.worker().drain()).resolves.toBe(1);

    const replaced = await digests.read(host.token, meeting.id);
    expect(replaced.status).toBe('ready');
    expect(decisionsOf(replaced)).toEqual([FIRST]);
    expect(replaced.content?.outOfDate).toBe(false);
    expect(JSON.stringify(replaced)).not.toContain(SECOND);
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]?.prompt).toContain(FIRST);
    expect(claude.calls[1]?.prompt).not.toContain(SECOND);
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      sources: [first.id],
    });
  });

  it('withholds a digest by the read alone while nothing has reacted to the delete, and the next delete catches up', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const first = await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.worker().drain();
    const document = await transcription.uploadReady(host.token, meeting.id, fixture('sample.pdf'));
    const before = await digests.read(host.token, meeting.id);
    expect(decisionsOf(before)).toEqual([FIRST, SECOND]);

    // Deleted with no event: the state of a process killed between a delete and the
    // reaction to it. Nothing has touched the digest, and nothing will until something else
    // happens in the meeting.
    await setMeetingFileState(suite.prisma(), second.id, { status: 'deleted' });

    // The words are still in the tables, and the read is what keeps them from being served.
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      decisions: [FIRST, SECOND],
      sources: [first.id, second.id].toSorted(),
    });
    await expect(digests.read(host.token, meeting.id)).resolves.toEqual({
      meetingId: meeting.id,
      version: before.version,
      status: 'ready',
    });

    // The next delete in the meeting — of a file the digest was never built from — asks
    // whether every source is still transcribed, and finds the one that is not.
    await digests.remove(host.token, meeting.id, document.id);

    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: QUEUED,
      summary: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    await expect(digests.worker().drain()).resolves.toBe(1);
    expect(decisionsOf(await digests.read(host.token, meeting.id))).toEqual([FIRST]);
  });

  it('leaves no digest, and makes no call, when the only transcribed recording is deleted', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const only = await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const before = await digests.read(host.token, meeting.id);
    expect(before.status).toBe('ready');

    await digests.remove(host.token, meeting.id, only.id);

    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      failure_reason: null,
      attempts: 0,
      leased_until: null,
      summary: null,
      generated_at: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    // The row stays for its version, which a page that saw the digest has to be able to beat.
    const after = await digests.read(host.token, meeting.id);
    expect(after).toEqual({ meetingId: meeting.id, version: after.version });
    expect(after.version).toBeGreaterThan(before.version);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it('asks Claude for nothing when the only recording is deleted before its digest was claimed', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const only = await digests.transcribe(host.token, meeting.id, FIRST);

    await digests.remove(host.token, meeting.id, only.id);

    // Cleared by the delete itself: there is no claim left to find that out.
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      attempts: 0,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toEqual([]);
  });

  it('still withdraws a digest with the setting off, and queues nothing in its place', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    await digests.worker().drain();
    digests.configure({ enabled: false });

    await digests.remove(host.token, meeting.id, second.id);

    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: null,
      summary: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual(
      NOTHING_STORED,
    );
    const after = await digests.read(host.token, meeting.id);
    expect(after).toEqual({ meetingId: meeting.id, version: after.version });

    // Nothing is generated when the setting comes back either: nothing was asked for.
    digests.configure({ enabled: true });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it('takes the out-of-date mark off again when the recording that put it there is deleted', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const current = await digests.read(host.token, meeting.id);
    digests.configure({ enabled: false });
    const second = await digests.transcribe(host.token, meeting.id, SECOND);
    const marked = await digests.read(host.token, meeting.id);
    expect(marked.content).toEqual({ ...current.content, outOfDate: true });

    await digests.remove(host.token, meeting.id, second.id);

    // The digest was not built from it, so it stays — under a version of its own, because
    // what a page is shown has changed.
    const after = await digests.read(host.token, meeting.id);
    expect(after.status).toBe('ready');
    expect(after.content).toEqual(current.content);
    expect(after.version).toBeGreaterThan(marked.version);
  });

  it('changes nothing about a digest when a file that is not a recording is deleted', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();
    const document = await transcription.uploadReady(host.token, meeting.id, fixture('sample.pdf'));
    const before = await digests.read(host.token, meeting.id);

    await digests.remove(host.token, meeting.id, document.id);

    await expect(digests.read(host.token, meeting.id)).resolves.toEqual(before);
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });
});
