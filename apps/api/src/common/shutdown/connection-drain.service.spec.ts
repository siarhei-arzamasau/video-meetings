import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ConnectionDrainService } from './connection-drain.service';

interface Answer {
  status: number;
  connection: string | undefined;
  body: string;
  /** The client's end of the socket that carried the answer: the same port is the same connection. */
  clientPort: number | undefined;
}

const HOST = '127.0.0.1';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nothing = (): void => undefined;

/** One GET over the agent, read to its end. */
function get(port: number, agent: http.Agent, path = '/'): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    http
      .get({ host: HOST, port, path, agent }, (response) => {
        const clientPort = response.socket.localPort;
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            connection: response.headers.connection,
            body,
            clientPort,
          }),
        );
      })
      .on('error', reject);
  });
}

/** Whether the server finishes closing within a second, or is still held open. */
function closing(server: http.Server): Promise<'closed' | 'still open'> {
  return Promise.race([
    new Promise<'closed'>((resolve) => server.close(() => resolve('closed'))),
    wait(1_000).then(() => 'still open' as const),
  ]);
}

describe('ConnectionDrainService', () => {
  let agent: http.Agent;
  let server: http.Server;
  let port: number;
  /** Resolves when `/slow` or `/pending` is being handled; calling `finishSlow` ends it. */
  let slowStarted: Promise<void>;
  let finishSlow: () => void;

  /**
   * A server with two answers that wait to be finished — `/slow` after sending its first
   * half, `/pending` before sending anything — behind the drain's middleware or without it.
   */
  const listen = async (drain?: ConnectionDrainService): Promise<void> => {
    let started = nothing;

    slowStarted = new Promise<void>((resolve) => (started = resolve));

    const answer: http.RequestListener = (request, response) => {
      if (request.url !== '/slow' && request.url !== '/pending') {
        response.end('ok');

        return;
      }

      if (request.url === '/slow') {
        response.write('first half, ');
      }

      finishSlow = () => response.end('second half');
      started();
    };

    server = http.createServer((request, response) => {
      if (drain === undefined) {
        answer(request, response);
      } else {
        drain.middleware(request, response, () => answer(request, response));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    ({ port } = server.address() as AddressInfo);
  };

  /** Keeps asking over the one kept-alive connection, as a page polling the API does. */
  const poll = (): NodeJS.Timeout =>
    setInterval(() => {
      get(port, agent).catch(() => undefined);
    }, 20);

  beforeEach(() => {
    // One socket, kept alive: every request reuses the connection the last one left open.
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  });

  afterEach(() => {
    agent.destroy();
    server.closeAllConnections();
    server.close();
  });

  it('leaves a kept-alive connection alone until shutdown begins', async () => {
    await listen(new ConnectionDrainService());

    const first = await get(port, agent);
    const second = await get(port, agent);

    expect(second.connection).toBe('keep-alive');
    expect(second.clientPort).toBe(first.clientPort);
  });

  it('answers a request that arrives after shutdown began, then closes its connection', async () => {
    const drain = new ConnectionDrainService();

    await listen(drain);
    const before = await get(port, agent);

    drain.onModuleDestroy();
    const during = await get(port, agent);
    const after = await get(port, agent);

    // Answered in full on the connection it arrived on, and told not to use it again.
    expect(during).toEqual({ ...before, connection: 'close' });
    expect(after.clientPort).not.toBe(before.clientPort);
  });

  it('tells the client of a request still being handled not to reuse its connection', async () => {
    const drain = new ConnectionDrainService();

    await listen(drain);
    const pending = get(port, agent, '/pending');

    await slowStarted;
    drain.onModuleDestroy();
    finishSlow();

    await expect(pending).resolves.toMatchObject({ body: 'second half', connection: 'close' });
    const next = await get(port, agent);

    expect(next.clientPort).not.toBe((await pending).clientPort);
  });

  it('sends a response already under way in full, then closes the connection it was on', async () => {
    const drain = new ConnectionDrainService();

    await listen(drain);
    const slow = get(port, agent, '/slow');

    await slowStarted;
    drain.onModuleDestroy();
    finishSlow();

    // Its headers went out before shutdown began, so they promised to keep the connection.
    await expect(slow).resolves.toMatchObject({
      body: 'first half, second half',
      connection: 'keep-alive',
    });
    // The client was not told, so it learns from the socket closing: give that a moment, as a
    // page's next request a second or three later does.
    await wait(50);
    const next = await get(port, agent);

    expect(next.clientPort).not.toBe((await slow).clientPort);
  });

  it('lets the server close while a client keeps polling over the connection it had', async () => {
    const drain = new ConnectionDrainService();

    await listen(drain);
    const slow = get(port, agent, '/slow');

    await slowStarted;
    drain.onModuleDestroy();
    // Asked to close with a response in flight: this connection is not idle, so Node keeps it.
    const closed = closing(server);

    finishSlow();
    await slow;
    const polling = poll();

    await expect(closed).resolves.toBe('closed');
    clearInterval(polling);
  });

  // Why this class exists. Node closes idle connections once, when `close()` is called; one that
  // was busy then is kept alive afterwards, and every request on it keeps the server open.
  it('is needed: without it, the same client holds a closing server open', async () => {
    await listen();
    const slow = get(port, agent, '/slow');

    await slowStarted;
    const closed = closing(server);

    finishSlow();
    await slow;
    const polling = poll();

    await expect(closed).resolves.toBe('still open');
    clearInterval(polling);
  });
});
