import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';

import { createRequestLogger } from './request-logger';

interface ResponseState {
  statusCode: number;
  writableFinished: boolean;
  headersSent: boolean;
}

const LINE = /^(?<method>\S+) (?<url>\S+) (?<outcome>.+) (?<duration>\d+)ms$/;

/** Ends a response the way a handler does: answered in full, then closed. */
const finish = (response: EventEmitter & ResponseState, statusCode: number): void => {
  Object.assign(response, { statusCode, writableFinished: true, headersSent: true });
  response.emit('close');
};

describe('createRequestLogger', () => {
  const log = jest.fn();
  const warn = jest.fn();
  const next = jest.fn();

  /** Runs one request through the middleware and hands back the response to end. */
  const begin = (method: string, originalUrl: string): EventEmitter & ResponseState => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      headersSent: false,
    });

    createRequestLogger({ log, warn })(
      { method, originalUrl } as Request,
      response as unknown as Response,
      next,
    );

    return response;
  };

  beforeEach(() => {
    log.mockReset();
    warn.mockReset();
    next.mockReset();
  });

  it('hands the request on at once and logs nothing until the response is over', () => {
    begin('GET', '/api/meetings');

    expect(next).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs an answered request once, with its method, path, status and duration', () => {
    finish(begin('GET', '/api/meetings?order=desc&limit=3'), 200);

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(LINE.exec(String(log.mock.calls[0]?.[0]))?.groups).toMatchObject({
      method: 'GET',
      url: '/api/meetings?order=desc&limit=3',
      outcome: '200',
    });
  });

  // What an interceptor never saw: a guard's 401 or 429, and a path no route matches.
  it.each([400, 401, 403, 404, 409, 429, 500])('logs a %i as a warning', (statusCode) => {
    finish(begin('POST', '/api/auth/login'), statusCode);

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      new RegExp(`^POST /api/auth/login ${String(statusCode)} \\d+ms$`),
    );
  });

  it.each([200, 201, 204, 304, 308])('logs a %i as an ordinary line', (statusCode) => {
    finish(begin('GET', '/api/health'), statusCode);

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  // A files stream writes many times and ends once; a page that navigates away ends it by
  // closing the connection, with the headers long sent and the response never finished.
  it('logs a stream the client closed once, and says who closed it', () => {
    const response = begin('GET', '/api/meetings/1/files/events');

    Object.assign(response, { headersSent: true });
    response.emit('close');

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(LINE.exec(String(log.mock.calls[0]?.[0]))?.groups).toMatchObject({
      outcome: '200 (closed by the client)',
    });
  });

  it('does not report a status for a request whose client left before any answer', () => {
    begin('PUT', '/api/meetings/1/files/uploads/2/chunks/0').emit('close');

    expect(LINE.exec(String(log.mock.calls[0]?.[0]))?.groups).toMatchObject({
      outcome: 'unanswered (closed by the client)',
    });
  });

  it('measures from the request to the end of its response', () => {
    jest.useFakeTimers({ now: 1_000 });

    try {
      const response = begin('GET', '/api/meetings');

      jest.setSystemTime(1_250);
      finish(response, 200);

      expect(String(log.mock.calls[0]?.[0])).toBe('GET /api/meetings 200 250ms');
    } finally {
      jest.useRealTimers();
    }
  });
});
