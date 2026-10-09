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
import {
  CHUNK_INDEX_MESSAGE,
  CHUNK_LENGTH_MESSAGE,
} from '../commands/handlers/store-chunk.handler';
import { MeetingFileUploadRepository } from '../services/meeting-file-upload.repository';
import { UPLOAD_NOT_FOUND } from '../services/owned-upload';
import { MeetingFileChunkInterceptor } from './meeting-file-chunk.interceptor';

type ParserCallback = (error?: unknown) => void;

const parseChunk = jest.fn();
const createParser = jest.fn((_options: { limit: number }) => parseChunk);

// The real parser reads the request body; the point here is when it is asked to, how much it
// is allowed to hold, and what becomes of its failures.
jest.mock('express', () => ({ raw: (options: { limit: number }) => createParser(options) }));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const UPLOAD_ID = '55555555-5555-4555-8555-555555555555';

/** Three chunks: two whole ones of eight bytes, then the four that are left. */
const SESSION = { id: UPLOAD_ID, size: 20, chunkSize: 8, chunkCount: 3 };

const contextFor = (request: object): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  }) as unknown as ExecutionContext;
const chunkRequest = (index: string, uploadId = UPLOAD_ID): object => ({
  params: { id: MEETING_ID, uploadId, index },
  user: { id: USER_ID },
});
const signedIn = chunkRequest('0');

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
  const findOwned = jest.fn();
  const handle = jest.fn();
  const next: CallHandler = { handle };
  let interceptor: MeetingFileChunkInterceptor;

  const failureOf = (request: object): Promise<unknown> =>
    interceptor.intercept(contextFor(request), next).catch((error: unknown) => error);

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue({ id: MEETING_ID });
    findOwned.mockReset().mockResolvedValue(SESSION);
    handle.mockReset().mockReturnValue(of(undefined));
    createParser.mockClear();
    parseChunk
      .mockReset()
      .mockImplementation((_request: unknown, _response: unknown, done: ParserCallback) => done());

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileChunkInterceptor,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileUploadRepository, useValue: { findOwned } },
      ],
    }).compile();

    interceptor = moduleRef.get(MeetingFileChunkInterceptor);
  });

  it('resolves the meeting, then the session, then reads the chunk, then hands on', async () => {
    await interceptor.intercept(contextFor(signedIn), next);

    expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, MEETING_ID));
    expect(findOwned).toHaveBeenCalledWith(MEETING_ID, UPLOAD_ID, USER_ID);

    const order = [execute, findOwned, parseChunk, handle].map(
      (step) => step.mock.invocationCallOrder[0] ?? 0,
    );

    expect(order).toEqual([...order].toSorted((a, b) => a - b));
    expect(order.every((position) => position > 0)).toBe(true);
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

  it('answers 400 for an upload id that is not a uuid, without asking about the meeting', async () => {
    await expect(
      interceptor.intercept(contextFor(chunkRequest('0', 'upload-1')), next),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(execute).not.toHaveBeenCalled();
    expect(parseChunk).not.toHaveBeenCalled();
  });

  it('answers 404 to a stranger without reading the body', async () => {
    execute.mockResolvedValue(null);

    await expect(interceptor.intercept(contextFor(signedIn), next)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // The stranger is told about the meeting and never asked about the session.
    expect(findOwned).not.toHaveBeenCalled();
    // A chunk of memory the API never had to hold.
    expect(parseChunk).not.toHaveBeenCalled();
  });

  // What a member of the meeting could hold before this check: a whole chunk per connection,
  // against a session id they made up.
  it('answers 404 for a session that is not the caller’s, without reading the body', async () => {
    findOwned.mockResolvedValue(null);

    const failure = await failureOf(signedIn);

    expect(failure).toBeInstanceOf(NotFoundException);
    expect((failure as NotFoundException).message).toBe(UPLOAD_NOT_FOUND);
    expect(parseChunk).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    ['one past the last chunk', '3'],
    ['a word', 'abc'],
    ['a negative index', '-1'],
    ['a leading zero', '00'],
  ])('answers 400 for %s, without reading the body', async (_description, index) => {
    const failure = await failureOf(chunkRequest(index));

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toBe(CHUNK_INDEX_MESSAGE);
    expect(parseChunk).not.toHaveBeenCalled();
  });

  it.each([
    ['a whole chunk', '0', 8],
    ['the last chunk, which is the remainder', '2', 4],
  ])('reads no more than %s holds', async (_description, index, length) => {
    await interceptor.intercept(contextFor(chunkRequest(index)), next);

    expect(createParser).toHaveBeenCalledTimes(1);
    expect(createParser.mock.calls[0]?.[0]).toMatchObject({ limit: length, inflate: false });
  });

  it('answers a body over the chunk’s length with the contract message for a wrong-length chunk', async () => {
    failParserWith(parserError(413, 'request entity too large'));

    const failure = await failureOf(signedIn);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toBe(CHUNK_LENGTH_MESSAGE);
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'request aborted'],
    [415, 'content encoding unsupported'],
  ])('keeps the parser client error %i as that status', async (status, message) => {
    failParserWith(parserError(status, message));

    const failure = await failureOf(signedIn);

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
