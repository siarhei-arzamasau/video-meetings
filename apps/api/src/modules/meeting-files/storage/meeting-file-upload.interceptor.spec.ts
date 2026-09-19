import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';

import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import { MeetingFileStorage } from './meeting-file-storage';
import { MeetingFileUploadInterceptor } from './meeting-file-upload.interceptor';

const multerIntercept = jest.fn();

// The real multer interceptor reads the request body; the point here is what happens before
// it is ever asked to.
jest.mock('@nestjs/platform-express', () => ({
  FileInterceptor: () =>
    class {
      intercept = multerIntercept;
    },
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const contextFor = (request: object): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
const next: CallHandler = { handle: () => of(undefined) };

describe('MeetingFileUploadInterceptor', () => {
  const execute = jest.fn();
  let interceptor: MeetingFileUploadInterceptor;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue({ id: MEETING_ID });
    multerIntercept.mockReset().mockResolvedValue(of(undefined));

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFileUploadInterceptor,
        { provide: MeetingFileStorage, useValue: { tempDir: () => '/tmp' } },
        { provide: QueryBus, useValue: { execute } },
      ],
    }).compile();

    interceptor = moduleRef.get(MeetingFileUploadInterceptor);
  });

  it('resolves the meeting before handing the body to multer', async () => {
    await interceptor.intercept(
      contextFor({ params: { id: MEETING_ID }, user: { id: USER_ID } }),
      next,
    );

    expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, MEETING_ID));
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      multerIntercept.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('answers 404 to a stranger without reading the body', async () => {
    execute.mockResolvedValue(null);

    await expect(
      interceptor.intercept(
        contextFor({ params: { id: MEETING_ID }, user: { id: USER_ID } }),
        next,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Not written to disk and not removed: 100 MB the API never had to hold.
    expect(multerIntercept).not.toHaveBeenCalled();
  });

  it('answers 400 for an id that is not a uuid without reading the body', async () => {
    await expect(
      interceptor.intercept(
        contextFor({ params: { id: 'meeting-1' }, user: { id: USER_ID } }),
        next,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(execute).not.toHaveBeenCalled();
    expect(multerIntercept).not.toHaveBeenCalled();
  });

  it('throws when the guard did not attach a user, like @CurrentUser() does', async () => {
    await expect(
      interceptor.intercept(contextFor({ params: { id: MEETING_ID } }), next),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(multerIntercept).not.toHaveBeenCalled();
  });
});
