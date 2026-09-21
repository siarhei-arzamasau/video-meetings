import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';

import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import { CHUNK_LENGTH_MESSAGE } from '../commands/handlers/store-chunk.handler';
import { MeetingFileChunkInterceptor } from './meeting-file-chunk.interceptor';

type ParserCallback = (error?: unknown) => void;

const parseChunk = jest.fn();

// The real parser reads the request body; the point here is when it is asked to, and what
// becomes of its failures.
jest.mock('express', () => ({ raw: () => parseChunk }));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const contextFor = (request: object): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  }) as unknown as ExecutionContext;
const signedIn = { params: { id: MEETING_ID }, user: { id: USER_ID } };

/** An `http-errors` failure as the parser reports it: an `Error` carrying a `status`. */
const parserError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

const failParserWith = (error: unknown): void => {
  parseChunk.mockImplementation((_request: unknown, _response: unknown, done: ParserCallback) =>
    done(error),
  );
};

describe('MeetingFileChunkInterceptor', () => {
  const execute = jest.fn();
  const handle = jest.fn();
  const next: CallHandler = { handle };
  let interceptor: MeetingFileChunkInterceptor;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue({ id: MEETING_ID });
    handle.mockReset().mockReturnValue(of(undefined));
    parseChunk
      .mockReset()
      .mockImplementation((_request: unknown, _response: unknown, done: ParserCallback) => done());

    const moduleRef = await Test.createTestingModule({
      providers: [MeetingFileChunkInterceptor, { provide: QueryBus, useValue: { execute } }],
    }).compile();

    interceptor = moduleRef.get(MeetingFileChunkInterceptor);
  });

  it('resolves the meeting, then reads the chunk, then hands on to the route', async () => {
    await interceptor.intercept(contextFor(signedIn), next);

    expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, MEETING_ID));
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      parseChunk.mock.invocationCallOrder[0] ?? 0,
    );
    expect(parseChunk.mock.invocationCallOrder[0]).toBeLessThan(
      handle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('throws when the guard did not attach a user, without reading the body', async () => {
    await expect(
      interceptor.intercept(contextFor({ params: { id: MEETING_ID } }), next),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(parseChunk).not.toHaveBeenCalled();
  });

  it('answers 400 for a meeting id that is not a uuid, without reading the body', async () => {
    await expect(
      interceptor.intercept(
        contextFor({ params: { id: 'meeting-1' }, user: { id: USER_ID } }),
        next,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(execute).not.toHaveBeenCalled();
    expect(parseChunk).not.toHaveBeenCalled();
  });

  it('answers 404 to a stranger without reading the body', async () => {
    execute.mockResolvedValue(null);

    await expect(interceptor.intercept(contextFor(signedIn), next)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // A chunk of memory the API never had to hold.
    expect(parseChunk).not.toHaveBeenCalled();
  });

  it('answers a body over one chunk with the contract message for a wrong-length chunk', async () => {
    failParserWith(parserError(413, 'request entity too large'));

    const failure: unknown = await interceptor
      .intercept(contextFor(signedIn), next)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toBe(CHUNK_LENGTH_MESSAGE);
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'request aborted'],
    [415, 'content encoding unsupported'],
  ])('keeps the parser client error %i as that status', async (status, message) => {
    failParserWith(parserError(status, message));

    const failure: unknown = await interceptor
      .intercept(contextFor(signedIn), next)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpException);
    expect((failure as HttpException).getStatus()).toBe(status);
    expect((failure as HttpException).message).toBe(message);
  });

  it('leaves any other failure alone, for the filter to answer as a 500', async () => {
    const unexpected = new Error('disk on fire');
    failParserWith(unexpected);

    await expect(interceptor.intercept(contextFor(signedIn), next)).rejects.toBe(unexpected);
  });
});
