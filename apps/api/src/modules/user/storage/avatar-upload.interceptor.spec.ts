import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AVATAR_SIZE_MESSAGE } from '@repo/shared';
import { MulterError } from 'multer';
import { lastValueFrom, of, throwError } from 'rxjs';

import { AvatarStorage } from './avatar-storage';
import { AVATAR_FIELD, AvatarUploadInterceptor } from './avatar-upload.interceptor';

const multerIntercept = jest.fn();

// The real multer interceptor reads the request body; what is under test is what this
// interceptor does with each way multer, or the handler after it, can end.
jest.mock('@nestjs/platform-express', () => ({
  FileInterceptor: () =>
    class {
      intercept = multerIntercept;
    },
}));

const contextFor = (request: object): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
const next: CallHandler = { handle: () => of(undefined) };

describe('AvatarUploadInterceptor', () => {
  let interceptor: AvatarUploadInterceptor;
  let scratch: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-upload-interceptor-'));
  });

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    multerIntercept.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AvatarUploadInterceptor,
        { provide: AvatarStorage, useValue: { tempDir: () => scratch } },
      ],
    }).compile();

    interceptor = moduleRef.get(AvatarUploadInterceptor);
  });

  /** A temp file as multer would have left it, and the request that points at it. */
  const requestWithTempFile = (): { request: object; tempPath: string } => {
    const tempPath = path.join(scratch, `upload-${String(Date.now())}-${String(Math.random())}`);
    fs.writeFileSync(tempPath, 'image bytes');

    return { request: { file: { path: tempPath } }, tempPath };
  };

  it("answers multer's size limit with the shared avatar sentence", async () => {
    multerIntercept.mockRejectedValue(new MulterError('LIMIT_FILE_SIZE', AVATAR_FIELD));

    await expect(interceptor.intercept(contextFor({}), next)).rejects.toThrow(
      new PayloadTooLargeException(AVATAR_SIZE_MESSAGE),
    );
  });

  it('answers any other multer rejection with a 400, never a 500', async () => {
    multerIntercept.mockRejectedValue(new MulterError('LIMIT_UNEXPECTED_FILE', 'photo'));

    await expect(interceptor.intercept(contextFor({}), next)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('removes the temp file when multer itself rejects the upload', async () => {
    const { request, tempPath } = requestWithTempFile();
    multerIntercept.mockRejectedValue(new MulterError('LIMIT_FILE_SIZE', AVATAR_FIELD));

    await expect(interceptor.intercept(contextFor(request), next)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('removes the temp file when the handler after multer fails, and passes its error on', async () => {
    const { request, tempPath } = requestWithTempFile();
    const failure = new BadRequestException('That image could not be read.');
    multerIntercept.mockResolvedValue(throwError(() => failure));

    const result = await interceptor.intercept(contextFor(request), next);

    await expect(lastValueFrom(result)).rejects.toBe(failure);
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it('leaves the file to the handler when the upload succeeds', async () => {
    const { request, tempPath } = requestWithTempFile();
    multerIntercept.mockResolvedValue(of('stored'));

    const result = await interceptor.intercept(contextFor(request), next);

    await expect(lastValueFrom(result)).resolves.toBe('stored');
    expect(fs.existsSync(tempPath)).toBe(true);
  });
});
