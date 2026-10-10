import type { INestApplication } from '@nestjs/common';
import type { MeetingDigest } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import { createTestApp } from './utils/create-test-app';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL, PENDING_DIGEST_REQUESTS_TOKEN } from './utils/fixtures';
import { findMeetingDigestRow } from './utils/meeting-digests-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const READY_WITHIN_MS = 10_000;
const LOOK_EVERY_MS = 100;

/** The two settings a boot reads to decide whether it catches up. */
interface BootSettings {
  MEETING_FILES_WORKER_ENABLED: boolean;
  MEETING_DIGEST_ENABLED: boolean;
}

/**
 * The catch-up as a boot runs it: nobody calls `run()` here. An application is started with
 * its settings and the test looks at what it did by itself — which is the only spec that
 * would notice the hook asking the buses before their handlers are registered, since that
 * failure is caught, logged, and otherwise silent.
 */
describe('an application booting over meetings that are owed a digest', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);
  /** Applications a test booted and has not yet shut down itself. */
  const booted: INestApplication[] = [];

  afterEach(async () => {
    await Promise.all(booted.splice(0).map((app) => app.close()));
  });

  /** A meeting whose one recording was transcribed with the digest off: owed, with no row. */
  const owedMeeting = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meeting.id, FIRST);

    return { host, meetingId: meeting.id };
  };

  /**
   * Boots a second application with `settings`, a Claude of its own to count calls on, and
   * returns once whatever its boot started has been written.
   */
  const boot = async (settings: BootSettings): Promise<FakeClaudeAgent> => {
    const bootedClaude = new FakeClaudeAgent();
    const app = await createTestApp({
      overrides: [bootedClaude.override()],
      config: { ...settings },
    });

    booted.push(app);
    await app.get<{ settled(): Promise<void> }>(PENDING_DIGEST_REQUESTS_TOKEN).settled();

    return bootedClaude;
  };

  /** The digest once the booted application's own worker has generated it, or as it was last. */
  const readyDigest = async (
    host: RegisteredUser,
    meetingId: string,
    deadline = Date.now() + READY_WITHIN_MS,
  ): Promise<MeetingDigest> => {
    const digest = await digests.read(host.token, meetingId);

    if (digest.status === 'ready' || Date.now() > deadline) {
      return digest;
    }

    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));

    return readyDigest(host, meetingId, deadline);
  };

  it('asks for what is owed and generates it, with nobody asking', async () => {
    const { host, meetingId } = await owedMeeting();

    const bootedClaude = await boot({
      MEETING_FILES_WORKER_ENABLED: true,
      MEETING_DIGEST_ENABLED: true,
    });

    // Queued by the time the boot's own work has settled, and then the worker's to claim.
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      requested_revision: 1,
    });
    const ready = await readyDigest(host, meetingId);
    expect(ready.status).toBe('ready');
    expect(ready.content?.decisions.map(({ description }) => description)).toEqual([FIRST]);
    expect(bootedClaude.calls).toHaveLength(1);
    // The suite's own application booted with the digest off, and has asked Claude nothing.
    expect(claude.calls).toEqual([]);
  });

  it.each([
    ['the digest is off', { MEETING_FILES_WORKER_ENABLED: true, MEETING_DIGEST_ENABLED: false }],
    [
      'it is not a process that runs the workers',
      { MEETING_FILES_WORKER_ENABLED: false, MEETING_DIGEST_ENABLED: true },
    ],
  ] as const)('asks for nothing when %s', async (_why, settings) => {
    const { meetingId } = await owedMeeting();

    const bootedClaude = await boot(settings);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    expect(bootedClaude.calls).toEqual([]);
  });
});
