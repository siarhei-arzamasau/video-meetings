import { ConcurrencyLimit } from './concurrency-limit';

/** Work a test finishes when it chooses, recording that it began. */
function controlled(
  began: string[],
  name: string,
): { work: () => Promise<string>; finish: () => void } {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  return {
    work: async () => {
      began.push(name);
      await finished;

      return name;
    },
    finish,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ConcurrencyLimit', () => {
  it('runs work at once while there is a place free, and hands back its result', async () => {
    const limit = new ConcurrencyLimit(2);

    await expect(limit.run(() => Promise.resolve('done'))).resolves.toBe('done');
  });

  it('holds work back once every place is taken, and starts it as places come free', async () => {
    const limit = new ConcurrencyLimit(2);
    const began: string[] = [];
    const items = ['first', 'second', 'third'].map((name) => controlled(began, name));

    const running = items.map((item) => limit.run(item.work));
    await settle();

    expect(began).toEqual(['first', 'second']);

    items[0]?.finish();
    await settle();

    expect(began).toEqual(['first', 'second', 'third']);

    items[1]?.finish();
    items[2]?.finish();
    await expect(Promise.all(running)).resolves.toEqual(['first', 'second', 'third']);
  });

  it('starts the work that has waited longest first', async () => {
    const limit = new ConcurrencyLimit(1);
    const began: string[] = [];
    const items = ['first', 'second', 'third'].map((name) => controlled(began, name));

    const running = items.map((item) => limit.run(item.work));
    await settle();

    for (const item of items) {
      item.finish();
      // eslint-disable-next-line no-await-in-loop -- the order is the assertion
      await settle();
    }

    await Promise.all(running);
    expect(began).toEqual(['first', 'second', 'third']);
  });

  it('frees the place of work that fails', async () => {
    const limit = new ConcurrencyLimit(1);

    await expect(limit.run(() => Promise.reject(new Error('disk full')))).rejects.toThrow(
      'disk full',
    );
    await expect(limit.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });
});
