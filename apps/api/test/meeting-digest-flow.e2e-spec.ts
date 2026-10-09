import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FAKE_COST_USD, FAKE_MODEL, FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, OTHER_EMAIL, THIRD_EMAIL, meetingDigestUrl } from './utils/fixtures';
import { messageOf } from './utils/http';
import { TRANSCRIBED } from './utils/meeting-file-transcription-table';
import {
  GENERATING,
  QUEUED,
  READY,
  findMeetingDigestContentRows,
  findMeetingDigestRow,
} from './utils/meeting-digests-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import { fixture, useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';
const THIRD = 'The pricing page has to be updated before the launch.';

/** The decisions of a digest: with the fake Claude, the transcript of each recording it read. */
const decisionsOf = (digest: MeetingDigest): string[] =>
  digest.content?.decisions.map(({ description }) => description) ?? [];

describe('a meeting digest, from a transcribed recording to a stored one', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  it('leaves a recording ready and transcribed while its digest is queued, generating, then ready', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    // Nothing is promised about a digest before a transcript exists.
    await expect(digests.read(host.token, meeting.id)).resolves.toEqual({
      meetingId: meeting.id,
      version: 0,
    });
    const file = await digests.transcribe(host.token, meeting.id, FIRST);

    // Transcribed means transcribed: neither worker before this one spoke to Claude.
    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
    });
    expect(claude.calls).toEqual([]);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
      requested_revision: 1,
      summary: null,
    });
    const queued = await digests.read(host.token, meeting.id);
    expect(queued).toEqual({ meetingId: meeting.id, version: 1, status: 'queued' });

    claude.reply = () => ({ kind: 'hold' });
    const drained = digests.worker().drain();
    await claude.arrived(1);

    const generating = await digests.read(host.token, meeting.id);
    expect(generating).toEqual({ meetingId: meeting.id, version: 2, status: 'generating' });
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: GENERATING,
      attempts: 1,
      leased_until: expect.any(String),
    });

    claude.release();
    await expect(drained).resolves.toBe(1);

    const ready = await digests.read(host.token, meeting.id);
    expect(ready).toEqual({
      meetingId: meeting.id,
      version: 3,
      status: 'ready',
      content: {
        summary: 'A digest of 1 recording(s).',
        actionItems: [{ id: expect.any(String), description: 'Follow up on recording 1.' }],
        decisions: [{ id: expect.any(String), description: FIRST }],
        generatedAt: expect.any(String),
        outOfDate: false,
      },
    });
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toMatchObject({
      status: READY,
      attempts: 1,
      leased_until: null,
      failure_reason: null,
    });
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toEqual({
      actionItems: [{ description: 'Follow up on recording 1.', owner_name: null, owner_id: null }],
      decisions: [FIRST],
      sources: [file.id],
    });
  });

  it('asks for nothing when a PDF or a PNG is uploaded', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    await transcription.upload(host.token, meeting.id, fixture('sample.pdf'));
    await transcription.upload(host.token, meeting.id, fixture('sample.png'));

    await expect(transcription.fileWorker().drain()).resolves.toBe(2);
    await transcription.transcriptionWorker().drain();
    await digests.requested();

    await expect(digests.worker().drain()).resolves.toBe(0);
    await expect(findMeetingDigestRow(suite.prisma(), meeting.id)).resolves.toBeNull();
    expect(claude.calls).toEqual([]);
  });

  it('turns three recordings into one digest of all three, in upload order, with one call', async () => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);
    const files = [
      await digests.transcribe(host.token, meeting.id, FIRST),
      await digests.transcribe(host.token, meeting.id, SECOND),
      await digests.transcribe(host.token, meeting.id, THIRD),
    ];

    await expect(digests.worker().drain()).resolves.toBe(1);

    expect(claude.calls).toHaveLength(1);
    expect(decisionsOf(await digests.read(host.token, meeting.id))).toEqual([FIRST, SECOND, THIRD]);
    await expect(findMeetingDigestContentRows(suite.prisma(), meeting.id)).resolves.toMatchObject({
      sources: files.map(({ id }) => id).toSorted(),
    });
  });

  it('shows a participant the same digest, and a stranger a 404', async () => {
    const host = await registerUser(suite, EMAIL);
    const guest = await registerUser(suite, OTHER_EMAIL);
    const stranger = await registerUser(suite, THIRD_EMAIL);
    const meeting = await createMeeting(suite, host, [guest.id]);
    await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();

    const asHost = await digests.read(host.token, meeting.id);
    expect(asHost.status).toBe('ready');
    await expect(digests.read(guest.token, meeting.id)).resolves.toEqual(asHost);

    const url = meetingDigestUrl(meeting.id);
    const outside = await suite.get(url).set('Authorization', `Bearer ${stranger.token}`);
    expect(outside.status).toBe(404);
    expect(messageOf(outside)).toBe('Meeting not found');
    await suite.get(url).expect(401);
    await suite
      .get(meetingDigestUrl('not-a-uuid'))
      .set('Authorization', `Bearer ${host.token}`)
      .expect(400);
  });

  it('sends Claude what was said and nothing about who or where, and serves no cost', async () => {
    const host = await registerUser(suite, EMAIL);
    const guest = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [guest.id]);
    const file = await digests.transcribe(host.token, meeting.id, FIRST);
    await digests.worker().drain();

    const [sent] = claude.calls;
    expect(sent?.prompt).toBe(`<recording number="1">\n${FIRST}\n</recording>`);
    const leaving = JSON.stringify([sent?.prompt, sent?.systemPrompt]);
    for (const secret of [EMAIL, OTHER_EMAIL, host.id, guest.id, file.id, file.name]) {
      expect(leaving).not.toContain(secret);
    }
    // The one identifier that leaves, and only in the instructions: the run's tools take
    // the meeting's id as an argument, so the model is told which meeting it is.
    expect(sent?.prompt).not.toContain(meeting.id);
    expect(sent?.systemPrompt.split(meeting.id)).toHaveLength(2);
    expect(leaving).not.toMatch(/storage|\.transcript\.txt/);

    const served = JSON.stringify(await digests.read(host.token, meeting.id));
    for (const unserved of ['cost', String(FAKE_COST_USD), FAKE_MODEL, 'Tokens', 'attempts']) {
      expect(served).not.toContain(unserved);
    }
  });
});
