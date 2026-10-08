import { deferred } from '../../claude-agent/services/claude-agent-process.fixture';
import { PendingDigestRequests } from './pending-digest-requests';

/** Whether `waiting` has resolved by the time everything already queued has run. */
const hasSettled = async (waiting: Promise<void>): Promise<boolean> => {
  let done = false;
  void waiting.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  return done;
};

describe('PendingDigestRequests', () => {
  it('is settled at once when nothing is in flight', async () => {
    await expect(new PendingDigestRequests().settled()).resolves.toBeUndefined();
  });

  it('waits for every request in flight', async () => {
    const pending = new PendingDigestRequests();
    const first = deferred();
    const second = deferred();
    pending.track(first.promise);
    pending.track(second.promise);
    const settled = pending.settled();

    first.resolve();
    await expect(hasSettled(settled)).resolves.toBe(false);

    second.resolve();
    await expect(hasSettled(settled)).resolves.toBe(true);
  });

  it('waits for a request that started while it was waiting', async () => {
    const pending = new PendingDigestRequests();
    const first = deferred();
    const late = deferred();
    pending.track(first.promise);
    const settled = pending.settled();

    pending.track(late.promise);
    first.resolve();
    await expect(hasSettled(settled)).resolves.toBe(false);

    late.resolve();
    await expect(hasSettled(settled)).resolves.toBe(true);
  });

  it('holds shutdown until the requests in flight have been written', async () => {
    const pending = new PendingDigestRequests();
    const request = deferred();
    pending.track(request.promise);
    const destroyed = pending.onModuleDestroy();

    await expect(hasSettled(destroyed)).resolves.toBe(false);

    request.resolve();
    await expect(hasSettled(destroyed)).resolves.toBe(true);
  });
});
