import { Logger } from '@nestjs/common';

import { MeetingHooks } from '../src/modules/meeting-tools/meeting-hooks';
import { LiveMeetingDigest } from './utils/live-meeting-digest';
import { expectReferenceOutcomes, readDigestTranscript } from './utils/meeting-digest-fixtures';

/** A generation is a model thinking, not a nonce echoed: the suite's 60 seconds is too tight. */
const GENERATION_TIMEOUT_MS = 180_000;

/**
 * The budget of tool calls against Anthropic's real API, in its two halves: the model plans
 * for the number it is told, and the hooks hold it to the number whatever it was told.
 *
 * Every test spends a real request; see `claude-agent.live-spec.ts` for where the token
 * comes from and why.
 */
describe('The tool call budget of a generation, against the real Anthropic API', () => {
  let live: LiveMeetingDigest;

  beforeAll(async () => {
    live = await LiveMeetingDigest.start();
  });

  afterEach(() => {
    live.restoreToolCalls();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await live.close();
  });

  it(
    'begins no more tasks than its budget of calls can finish, and keeps every action item',
    async () => {
      // Two calls are one task: a search and a write. Told so, the model records the more
      // important of the reference's two and leaves the other to the digest — where, told
      // nothing, it searched for both and had no call left to write either.
      const warned = jest.spyOn(Logger.prototype, 'warn');
      const meetingId = crypto.randomUUID();
      live.limitToolCalls(2);

      const digest = await live.generateFrom(
        'reference, two tool calls allowed',
        [readDigestTranscript('reference')],
        meetingId,
      );

      expectReferenceOutcomes(digest);
      expect(live.tasks.of(meetingId)).toHaveLength(1);
      expect(live.tasks.callsFor(meetingId).map(({ method }) => method)).toEqual([
        'search',
        'upsert',
      ]);
      // Planned for, not run into: no call was made for a hook to refuse.
      expect(warned).not.toHaveBeenCalledWith(expect.stringContaining('denied'));
    },
    GENERATION_TIMEOUT_MS,
  );

  it(
    'is refused every tool call past what its hooks allow, logs the ones that ran, and still answers',
    async () => {
      // What no fake can say: that Claude Code asks the hooks about a tool of an in-process
      // server at all, that a refusal reaches the model as something to read, and that the
      // answer — a tool call too, to the SDK's own `StructuredOutput` — is not refused with
      // the rest. The hooks are made to allow one call under instructions that promise
      // twenty, since a model told its real budget plans for it and is never refused.
      const createHooks = MeetingHooks.prototype.createHooks;
      jest
        .spyOn(MeetingHooks.prototype, 'createHooks')
        .mockImplementation(function allowOneCall(this: MeetingHooks) {
          return createHooks.call(this, 1);
        });
      const logged = jest.spyOn(Logger.prototype, 'log');
      const warned = jest.spyOn(Logger.prototype, 'warn');
      const meetingId = crypto.randomUUID();

      const digest = await live.generateFrom(
        'reference, one tool call let through',
        [readDigestTranscript('reference')],
        meetingId,
      );

      expectReferenceOutcomes(digest);
      expect(live.tasks.callsFor(meetingId)).toHaveLength(1);
      expect(warned).toHaveBeenCalledWith(
        expect.stringMatching(/^Tool mcp__meeting__\w+ denied: call 2 of a run that may make 1$/),
      );
      const audited = logged.mock.calls.map(([line]) => String(line));
      expect(audited.filter((line) => /^Tool mcp__meeting__\w+ called: /.test(line))).toHaveLength(
        1,
      );
      expect(audited.join('\n')).not.toContain('StructuredOutput');
    },
    GENERATION_TIMEOUT_MS,
  );
});
