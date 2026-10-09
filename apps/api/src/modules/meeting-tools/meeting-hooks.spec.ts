import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '@nestjs/common';

import { MIN_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MAX_AUDITED_CHARACTERS, MeetingHooks } from './meeting-hooks';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const FIND_TASKS = 'mcp__meeting__find_tasks';
const UPSERT_TASK = 'mcp__meeting__upsert_task';
const UPDATE_MEETING = 'mcp__meeting__update_meeting';

/** The tool the SDK answers through. A run refused it can never end. */
const STRUCTURED_OUTPUT = 'StructuredOutput';

/** What every hook input carries, whatever the event. */
const RUN = { session_id: 'a-session', transcript_path: '', cwd: '/' };

const asked = (toolName: string, toolInput: unknown): HookInput => ({
  ...RUN,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'a-call',
});

const finished = (toolName: string, toolInput: unknown, toolResponse: unknown): HookInput => ({
  ...RUN,
  hook_event_name: 'PostToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_response: toolResponse,
  tool_use_id: 'a-call',
});

const failed = (toolName: string, toolInput: unknown, error: string): HookInput => ({
  ...RUN,
  hook_event_name: 'PostToolUseFailure',
  tool_name: toolName,
  tool_input: toolInput,
  error,
  tool_use_id: 'a-call',
});

const run = (hook: HookCallback, input: HookInput): Promise<HookJSONOutput> =>
  hook(input, 'a-call', { signal: new AbortController().signal });

const denialWith = (reason: unknown): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason as string,
  },
});

describe('MeetingHooks', () => {
  const hooks = new MeetingHooks();
  let logged: jest.SpyInstance;
  let warned: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createHooks', () => {
    it('registers the guard on upsert_task alone, and the budget and the log on every meeting tool', () => {
      const registered = hooks.createHooks(20);

      expect(registered).toEqual({
        PreToolUse: [
          { matcher: UPSERT_TASK, hooks: [hooks.preToolUseGuard] },
          { matcher: '^mcp__meeting__', hooks: [expect.any(Function)] },
        ],
        PostToolUse: [{ matcher: '^mcp__meeting__', hooks: [hooks.auditLog] }],
        PostToolUseFailure: [{ matcher: '^mcp__meeting__', hooks: [hooks.auditLog] }],
      });
    });

    it('makes each run a budget of its own', async () => {
      const [, firstRun] = hooks.createHooks(1).PreToolUse ?? [];
      const [, secondRun] = hooks.createHooks(1).PreToolUse ?? [];
      const call = asked(FIND_TASKS, { query: 'emails' });

      await run(firstRun!.hooks[0]!, call);
      await expect(run(firstRun!.hooks[0]!, call)).resolves.toEqual(denialWith(expect.any(String)));

      // Shared, the count of the first run would refuse the second its first call.
      await expect(run(secondRun!.hooks[0]!, call)).resolves.toEqual({});
    });
  });

  describe('preToolUseGuard', () => {
    it.each([
      ['empty', ''],
      ['blank', '   \n '],
      ['one character', 'x'],
      ['two characters', 'QA'],
      ['two characters among spaces', '  QA  '],
    ])(
      'denies upsert_task a title that is %s, and says what a title needs',
      async (_case, title) => {
        const answer = await run(
          hooks.preToolUseGuard,
          asked(UPSERT_TASK, { title, sourceMeetingId: MEETING_ID }),
        );

        expect(answer).toEqual(
          denialWith(expect.stringContaining(`at least ${MIN_TASK_TITLE_LENGTH} characters`)),
        );
        expect(warned).toHaveBeenCalledWith(expect.stringContaining(`Tool ${UPSERT_TASK} denied`));
      },
    );

    it.each([
      ['no title', { sourceMeetingId: MEETING_ID }],
      ['a title that is not text', { title: 12345, sourceMeetingId: MEETING_ID }],
      ['a title that is null', { title: null }],
      ['no arguments', undefined],
      ['arguments that are not an object', 'Rewrite the launch emails'],
    ])('denies upsert_task called with %s', async (_case, toolInput) => {
      // The model's own arguments, before the tool's shape has checked a thing.
      await expect(run(hooks.preToolUseGuard, asked(UPSERT_TASK, toolInput))).resolves.toEqual(
        denialWith(expect.stringContaining('empty')),
      );
    });

    it('names the title it refused, so the model can tell which call it was', async () => {
      const answer = await run(hooks.preToolUseGuard, asked(UPSERT_TASK, { title: ' QA ' }));

      expect(answer).toEqual(denialWith(expect.stringContaining('"QA"')));
    });

    it.each([
      ['exactly three characters', 'Fix'],
      ['three characters among spaces', '  Fix  '],
      ['a sentence', 'Rewrite the launch emails'],
      ['three Cyrillic characters', 'Чат'],
    ])('lets through a title of %s, with no decision of its own', async (_case, title) => {
      // No `allow`: whether the call may run stays `allowedTools`' to say.
      await expect(run(hooks.preToolUseGuard, asked(UPSERT_TASK, { title }))).resolves.toEqual({});
      expect(warned).not.toHaveBeenCalled();
    });

    it.each([
      ['find_tasks', asked(FIND_TASKS, { query: 'x' })],
      ['update_meeting', asked(UPDATE_MEETING, { meetingId: MEETING_ID, summary: 'x' })],
      ["the SDK's answer tool", asked(STRUCTURED_OUTPUT, { title: '' })],
      ['another event', finished(UPSERT_TASK, { title: '' }, {})],
    ])('has nothing to say about %s', async (_case, input) => {
      // Whatever the matcher it is registered under lets through, it decides by the name.
      await expect(run(hooks.preToolUseGuard, input)).resolves.toEqual({});
    });
  });

  describe('callBudget', () => {
    it('lets through as many calls as the limit, and denies every one after', async () => {
      const budget = hooks.callBudget(3);
      const calls = [
        asked(FIND_TASKS, { query: 'emails' }),
        asked(UPSERT_TASK, { title: 'Rewrite the launch emails' }),
        asked(UPDATE_MEETING, { meetingId: MEETING_ID }),
      ];

      for (const call of calls) {
        // In turn, as the model makes them: the count is the order.
        // oxlint-disable-next-line no-await-in-loop
        await expect(run(budget, call)).resolves.toEqual({});
      }

      const reason = expect.stringContaining('may call its tools 3 times');
      await expect(run(budget, asked(FIND_TASKS, { query: 'pricing' }))).resolves.toEqual(
        denialWith(reason),
      );
      await expect(run(budget, asked(UPSERT_TASK, { title: 'Update pricing' }))).resolves.toEqual(
        denialWith(reason),
      );
      expect(warned).toHaveBeenCalledTimes(2);
      expect(warned).toHaveBeenLastCalledWith(
        `Tool ${UPSERT_TASK} denied: call 5 of a run that may make 3`,
      );
    });

    it('tells a run that is out of calls to answer', async () => {
      const budget = hooks.callBudget(1);
      await run(budget, asked(FIND_TASKS, { query: 'emails' }));

      await expect(run(budget, asked(FIND_TASKS, { query: 'emails' }))).resolves.toEqual(
        denialWith(expect.stringContaining('answer now')),
      );
    });

    it('counts a call the guard would refuse: it was made all the same', async () => {
      const budget = hooks.callBudget(1);
      await run(budget, asked(UPSERT_TASK, { title: '' }));

      await expect(run(budget, asked(UPSERT_TASK, { title: 'Fix the build' }))).resolves.toEqual(
        denialWith(expect.any(String)),
      );
    });

    it("neither counts nor denies the SDK's answer tool, however far past the limit the run is", async () => {
      const budget = hooks.callBudget(1);
      await run(budget, asked(FIND_TASKS, { query: 'emails' }));
      await run(budget, asked(FIND_TASKS, { query: 'emails' }));

      // Refused this, a run that is out of calls could not do the one thing it is told to.
      await expect(run(budget, asked(STRUCTURED_OUTPUT, { summary: 'x' }))).resolves.toEqual({});
    });

    it('does not count what is not a call being asked for', async () => {
      const budget = hooks.callBudget(1);

      await run(budget, asked(STRUCTURED_OUTPUT, {}));
      await run(budget, finished(FIND_TASKS, { query: 'emails' }, {}));

      await expect(run(budget, asked(FIND_TASKS, { query: 'emails' }))).resolves.toEqual({});
    });
  });

  describe('auditLog', () => {
    it('logs the tool, its arguments, and its result, and changes nothing', async () => {
      const toolInput = { title: 'Rewrite the launch emails', sourceMeetingId: MEETING_ID };
      const toolResponse = [{ type: 'text', text: '{"task":{"status":"OPEN"}}' }];

      await expect(
        run(hooks.auditLog, finished(UPSERT_TASK, toolInput, toolResponse)),
      ).resolves.toEqual({});

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        `Tool ${UPSERT_TASK} called: arguments ${JSON.stringify(toolInput)}, ` +
          `result ${JSON.stringify(toolResponse)}`,
      );
    });

    it('logs a call that failed with its error', async () => {
      await run(hooks.auditLog, failed(FIND_TASKS, { query: 'emails' }, 'The tool timed out'));

      expect(logged).toHaveBeenCalledWith(
        `Tool ${FIND_TASKS} called: arguments {"query":"emails"}, error "The tool timed out"`,
      );
    });

    it('keeps what was said on one line, so a title cannot write a line of its own', async () => {
      const title = 'Fix the build\n[Nest] ERROR the database was dropped';

      await run(hooks.auditLog, finished(UPSERT_TASK, { title }, 'saved'));

      const [line] = logged.mock.calls[0] as [string];
      expect(line).not.toContain('\n');
      expect(line).toContain('Fix the build\\n[Nest]');
    });

    it('cuts arguments and a result past the bound, and says how long each was', async () => {
      const summary = 'a'.repeat(MAX_AUDITED_CHARACTERS * 4);
      const response = 'b'.repeat(MAX_AUDITED_CHARACTERS * 2);

      await run(hooks.auditLog, finished(UPDATE_MEETING, { summary }, response));

      const [line] = logged.mock.calls[0] as [string];
      expect(line.length).toBeLessThan(MAX_AUDITED_CHARACTERS * 2 + 200);
      expect(line).toContain(`… (${JSON.stringify({ summary }).length} characters)`);
      expect(line).toContain(`… (${response.length + 2} characters)`);
    });

    it('logs a result that cannot be written as JSON, rather than fail the hook', async () => {
      const circular: Record<string, unknown> = {};
      circular['itself'] = circular;

      await expect(
        run(hooks.auditLog, finished(FIND_TASKS, { query: 'emails' }, circular)),
      ).resolves.toEqual({});
      await run(hooks.auditLog, finished(FIND_TASKS, { query: 'emails' }, undefined));

      expect(logged).toHaveBeenNthCalledWith(1, expect.stringContaining('[not serialisable]'));
      expect(logged).toHaveBeenNthCalledWith(2, expect.stringContaining('result undefined'));
    });

    it.each([
      ["the SDK's answer tool", finished(STRUCTURED_OUTPUT, { summary: 'x' }, {})],
      ['a call that has not run yet', asked(UPSERT_TASK, { title: 'Fix the build' })],
    ])('logs nothing for %s', async (_case, input) => {
      await expect(run(hooks.auditLog, input)).resolves.toEqual({});
      expect(logged).not.toHaveBeenCalled();
    });
  });
});
