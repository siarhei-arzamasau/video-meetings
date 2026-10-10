import { useApiSuite } from './utils/api-suite';
import { useDigestSuite } from './utils/digest-suite';
import { FakeClaudeAgent } from './utils/fake-claude-agent';
import { EMAIL } from './utils/fixtures';
import { TRANSCRIBED } from './utils/meeting-file-transcription-table';
import { QUEUED, READY, findMeetingDigestRow } from './utils/meeting-digests-table';
import { findMeetingFileRow } from './utils/meeting-files-table';
import { createMeeting, registerUser } from './utils/meeting-files-suite';
import type { RegisteredUser } from './utils/meeting-files-suite';
import { useTranscriptionSuite } from './utils/transcription-suite';

const FIRST = 'We decided to move the launch to the fifteenth of April.';
const SECOND = 'Alice Johnson will rewrite the onboarding emails by Friday.';
const TOKEN_MESSAGE = 'ANTHROPIC_AUTH_TOKEN must be set when MEETING_DIGEST_ENABLED is on.';

/**
 * Builds the application afresh, in a module registry of its own, so the environment is
 * read again. **Compiled, not merely imported:** `ConfigModule.forRoot` is asynchronous,
 * so a contract that refuses the environment rejects a promise inside `AppModule`'s
 * `imports`, and nothing throws until Nest awaits it — which is the first thing a boot
 * does, and all that `compile()` here has to get to. Nothing is initialised or listening.
 */
const bootAfresh = (): Promise<void> =>
  jest.isolateModulesAsync(async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/app.module');

    await Test.createTestingModule({ imports: [AppModule] }).compile();
  });

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

/**
 * `MEETING_DIGEST_ENABLED` decides whether anything is sent to Anthropic, and nothing else:
 * switching it off neither erases what is stored nor stops it being read.
 */
describe('the meeting digest setting', () => {
  const claude = new FakeClaudeAgent();
  const suite = useApiSuite({ overrides: [claude.override()] });
  const transcription = useTranscriptionSuite(suite);
  const digests = useDigestSuite(suite, transcription, claude);

  const setUp = async (): Promise<{ host: RegisteredUser; meetingId: string }> => {
    const host = await registerUser(suite, EMAIL);
    const meeting = await createMeeting(suite, host);

    return { host, meetingId: meeting.id };
  };

  it('asks for nothing while it is off: a recording is transcribed and the meeting has no digest', async () => {
    const { host, meetingId } = await setUp();
    digests.configure({ enabled: false });

    const file = await digests.transcribe(host.token, meetingId, FIRST);

    await expect(findMeetingFileRow(suite.prisma(), file.id)).resolves.toMatchObject({
      status: 'ready',
      transcription_status: TRANSCRIBED,
    });
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    await expect(digests.worker().drain()).resolves.toBe(0);
    await expect(digests.read(host.token, meetingId)).resolves.toEqual({ meetingId, version: 0 });
    expect(claude.calls).toEqual([]);
  });

  it('starts nothing for a recording transcribed while it was off until a boot catches up, once it is on', async () => {
    const { host, meetingId } = await setUp();
    digests.configure({ enabled: false });
    await digests.transcribe(host.token, meetingId, FIRST);

    digests.configure({ enabled: true });

    await expect(digests.worker().drain()).resolves.toBe(0);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toBeNull();
    expect(claude.calls).toEqual([]);
  });

  it('still serves a stored digest while it is off, and says when it no longer covers everything', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);
    await digests.worker().drain();
    const stored = await digests.read(host.token, meetingId);
    expect(stored.status).toBe('ready');

    digests.configure({ enabled: false });

    await expect(digests.read(host.token, meetingId)).resolves.toEqual(stored);

    // A recording transcribed now asks for nothing — and the read still marks the digest,
    // under a version of its own: what a page is shown changed, though no generation did.
    await digests.transcribe(host.token, meetingId, SECOND);
    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: READY,
      requested_revision: 1,
    });
    await expect(digests.read(host.token, meetingId)).resolves.toEqual({
      ...stored,
      version: stored.version + 1,
      content: { ...stored.content, outOfDate: true },
    });
    expect(claude.calls).toHaveLength(1);
  });

  it('leaves a queued digest waiting while it is off, and generates it once it is back on', async () => {
    const { host, meetingId } = await setUp();
    await digests.transcribe(host.token, meetingId, FIRST);

    digests.configure({ enabled: false });
    await expect(digests.worker().drain()).resolves.toBe(0);

    await expect(findMeetingDigestRow(suite.prisma(), meetingId)).resolves.toMatchObject({
      status: QUEUED,
      attempts: 0,
      leased_until: null,
    });
    // Still reported: the status is what is stored, whatever the setting says today.
    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({ status: 'queued' });
    expect(claude.calls).toEqual([]);

    digests.configure({ enabled: true });
    await expect(digests.worker().drain()).resolves.toBe(1);

    await expect(digests.read(host.token, meetingId)).resolves.toMatchObject({ status: 'ready' });
  });

  describe('at boot', () => {
    const saved = {
      enabled: process.env['MEETING_DIGEST_ENABLED'],
      token: process.env['ANTHROPIC_AUTH_TOKEN'],
    };

    afterEach(() => {
      restore('MEETING_DIGEST_ENABLED', saved.enabled);
      restore('ANTHROPIC_AUTH_TOKEN', saved.token);
    });

    it('is off for the run itself, set by the suite rather than left to an env file', () => {
      // `test/setup-env.ts`. Unset, a developer's `.env` with the digest on would decide it
      // for every spec: the real Claude wherever the fake is not bound, and with the token
      // exported empty — the case below — no boot at all.
      expect(saved.enabled).toBe('false');
    });

    it('refuses to start with the digest on and no token, naming the variable', async () => {
      process.env['MEETING_DIGEST_ENABLED'] = 'true';
      // Empty rather than deleted: an env file may hold one, and the environment wins.
      process.env['ANTHROPIC_AUTH_TOKEN'] = '';

      await expect(bootAfresh()).rejects.toThrow(TOKEN_MESSAGE);
    });

    it('starts with the digest on and a token, without asking Anthropic whether it is good', async () => {
      process.env['MEETING_DIGEST_ENABLED'] = 'true';
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'a-token-nobody-issued';

      await expect(bootAfresh()).resolves.toBeUndefined();
    });

    it('starts with the digest off and no token', async () => {
      process.env['MEETING_DIGEST_ENABLED'] = 'false';
      process.env['ANTHROPIC_AUTH_TOKEN'] = '';

      await expect(bootAfresh()).resolves.toBeUndefined();
    });
  });
});
