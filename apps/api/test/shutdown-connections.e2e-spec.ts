import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

import { ConnectionDrainService } from '../src/common/shutdown/connection-drain.service';
import { createTestApp } from './utils/create-test-app';

const HOST = '127.0.0.1';

interface Answer {
  status: number;
  connection: string | undefined;
  /** The client's end of the socket: the same port is the same connection. */
  clientPort: number | undefined;
}

/** `GET /api/health` over the agent, read to its end. */
function health(port: number, agent: http.Agent): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    http
      .get({ host: HOST, port, path: '/api/health', agent }, (response) => {
        const clientPort = response.socket.localPort;

        response.resume();
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            connection: response.headers.connection,
            clientPort,
          }),
        );
      })
      .on('error', reject);
  });
}

/**
 * That `ConnectionDrainService` is wired into the application — its middleware in
 * `configureApp`, its provider in the root module. What it does to a socket is pinned beside
 * it, in a spec that needs no database; a middleware nobody registered would leave that spec
 * green and a stopped API answering its open pages.
 *
 * An app of its own, listening on a real port: supertest opens a connection per request, and
 * this is about what happens to one that is reused.
 */
describe('connections once shutdown has begun', () => {
  let app: INestApplication;
  let agent: http.Agent;
  let port: number;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, HOST);
    ({ port } = (app.getHttpServer() as http.Server).address() as AddressInfo);
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  });

  afterAll(async () => {
    agent.destroy();
    await app.close();
  });

  it('are kept alive until then, and closed behind the next answer after', async () => {
    const first = await health(port, agent);
    const second = await health(port, agent);

    expect(second).toEqual({ ...first, status: 200, connection: 'keep-alive' });

    // What `app.close()` runs first, without the rest of it: the server is still listening.
    app.get(ConnectionDrainService).onModuleDestroy();
    const during = await health(port, agent);
    const after = await health(port, agent);

    expect(during).toEqual({ ...first, connection: 'close' });
    expect(after.status).toBe(200);
    expect(after.clientPort).not.toBe(first.clientPort);
  });
});
