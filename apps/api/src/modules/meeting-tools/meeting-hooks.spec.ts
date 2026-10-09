import { Logger } from '@nestjs/common';

import { MIN_TASK_TITLE_LENGTH } from '../tasks/task.constants';
import { MeetingHooks } from './meeting-hooks';
import {
  FIND_TASKS,
  MEETING_ID,
  STRUCTURED_OUTPUT,
  UPDATE_MEETING,
  UPSERT_TASK,
  asked,
  denialWith,
  finished,
  run,
} from './meeting-hooks.fixture';

/**
 * What is registered, and the guard. The budget and the log have specs of their own:
 * `meeting-hooks.call-budget.spec.ts` and `meeting-hooks.audit-log.spec.ts`.
 */
describe('MeetingHooks', () => {
  const hooks = new MeetingHooks();
  let warned: jest.SpyInstance;

  beforeEach(() => {
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
});
