import { Logger } from '@nestjs/common';

import { MAX_AUDITED_CHARACTERS, MeetingHooks } from './meeting-hooks';
import {
  FIND_TASKS,
  MEETING_ID,
  STRUCTURED_OUTPUT,
  UPDATE_MEETING,
  UPSERT_TASK,
  asked,
  failed,
  finished,
  run,
} from './meeting-hooks.fixture';

describe('MeetingHooks: auditLog', () => {
  const hooks = new MeetingHooks();
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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
