import { Logger } from '@nestjs/common';

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

describe('MeetingHooks: callBudget', () => {
  const hooks = new MeetingHooks();
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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
