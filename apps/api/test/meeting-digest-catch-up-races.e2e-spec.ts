import type { INestApplication } from '@nestjs/common';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import { catchUpDigests, configureDigest, useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL } from './utils/fixtures';
import { QUEUED, READY, findMeetingDigestRow } from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';

const sum = (counts: number[]): number => counts.reduce((total, count) => total + count, 0);

/**
 * The catch-up beside everything else that asks for a digest. Each generation is a paid
 * request, so what is held here is a count: however many catch-ups run, and whatever a
 * recording asks for meanwhile, a meeting that is owed one digest is sent to Claude once.
 */
describe('a catch-up that is not the only one asking', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);
  /** Second applications a test started and has not yet shut down itself. */
  const replicas: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(replicas.splice(0).map((replica) => replica.close()));
  });

  /** A meeting whose one recording was transcribed with the digest off: owed, with no row. */
  const owedMeeting = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meeting.id, FIRST);
    digests.configure({ enabled: true });

    return { host, meetingId: meeting.id };
  };

  it('asks once when three run at the same time', async () => {
    const { meetingId } = await owedMeeting();

    const counts = await Promise.all([digests.catchUp(), digests.catchUp(), digests.catchUp()]);

    // One of them asked. The other two waited on the row it made and found it queued.
    expect(sum(counts)).toBe(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(1);
    expect(claude.calls).toHaveLength(1);
  });

  it('asks once when two applications boot beside each other', async () => {
    const { meetingId } = await owedMeeting();
    const replica = await createTestApp({ overrides: [new FakeClaudeAgent().override()] });
    replicas.push(replica);
    configureDigest(replica);

    const counts = await Promise.all([digests.catchUp(), catchUpDigests(replica)]);

    expect(sum(counts)).toBe(1);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 1,
    });
  });

  it('finds nothing owed the second time, once the digest it asked for is stored', async () => {
    const { meetingId } = await owedMeeting();
    await expect(digests.catchUp()).resolves.toBe(1);
    await digests.worker().drain();

    // What makes a boot after this one cost nothing: the digest a catch-up caused is, to
    // the next catch-up, current — built from exactly the recordings it finds transcribed.
    await expect(digests.catchUp()).resolves.toBe(0);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(0);
    expect(claude.calls).toHaveLength(1);
  });

  it("leaves a recording's own request alone, and the generation that request is owed", async () => {
    const { host, meetingId } = await owedMeeting();
    // A second recording, transcribed with the setting on: its request covers both.
    await digests.transcribe(host.token, meetingId, SECOND);

    await expect(digests.catchUp()).resolves.toBe(0);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      requested_revision: 1,
    });
    await expect(digests.worker().drain()).resolves.toBe(1);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]?.prompt).toContain(FIRST);
    expect(claude.calls[0]?.prompt).toContain(SECOND);
  });
});
