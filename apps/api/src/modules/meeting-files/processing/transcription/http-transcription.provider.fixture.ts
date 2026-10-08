import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { ConfigService } from '@nestjs/config';

export interface Received {
  method: string;
  contentType: string;
  authorization: string | undefined;
  transferEncoding: string | undefined;
  contentLength: string | undefined;
  connection: string | undefined;
  body: string;
}

/** A stand-in endpoint on a loopback port: the real client, a real socket, no network. */
export function startServer(
  handler: (received: Received, response: http.ServerResponse) => void,
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        contentType: request.headers['content-type'] ?? '',
        authorization: request.headers.authorization,
        transferEncoding: request.headers['transfer-encoding'],
        contentLength: request.headers['content-length'],
        connection: request.headers.connection,
        body: Buffer.concat(chunks).toString('latin1'),
      };
      received.push(entry);
      handler(entry, response);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}/v1/audio/transcriptions`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The model every case asks for unless it is about asking for another, or for none. */
export const MODEL = 'Systran/faster-whisper-small';

export const config = (values: Record<string, string>): ConfigService => {
  const configured: Record<string, string> = { TRANSCRIPTION_MODEL: MODEL, ...values };

  return {
    get: <T>(key: string, fallback?: T): T | string | undefined => configured[key] ?? fallback,
  } as unknown as ConfigService;
};

export const audio = (): Readable => Readable.from([Buffer.from('ID3 fake audio bytes')]);
