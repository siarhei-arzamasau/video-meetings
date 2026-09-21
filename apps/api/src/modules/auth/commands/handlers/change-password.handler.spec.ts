import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import {
  CURRENT_PASSWORD_MESSAGE,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_UNCHANGED_MESSAGE,
} from '@repo/shared';

import { UpdatePasswordHashCommand } from '../../../user/commands/update-password-hash.command';
import { FindUserCredentialsByIdQuery } from '../../../user/queries/find-user-credentials-by-id.query';
import { PasswordService } from '../../services/password.service';
import { ChangePasswordCommand } from '../change-password.command';
import { ChangePasswordHandler, NEW_PASSWORD_MESSAGE } from './change-password.handler';

const CURRENT = 'correct-horse-battery-42';
const NEW = 'a-different-battery-43';

/**
 * Every rejection is asserted the same way: the exception the caller sees, **and** that no
 * `UpdatePasswordHashCommand` was dispatched. A 400 that also wrote is not a rejection, and
 * the hash is the one thing in this handler worth being sure about.
 */
describe('ChangePasswordHandler', () => {
  const dispatch = jest.fn();
  const query = jest.fn();
  const verify = jest.fn<Promise<boolean>, [string, string]>();
  const hash = jest.fn<Promise<string>, [string]>();
  let handler: ChangePasswordHandler;

  const change = (currentPassword = CURRENT, newPassword = NEW): Promise<void> =>
    handler.execute(new ChangePasswordCommand('user-id', currentPassword, newPassword));

  beforeEach(async () => {
    dispatch.mockReset().mockResolvedValue(undefined);
    query.mockReset().mockResolvedValue({ id: 'user-id', passwordHash: 'stored-hash' });
    verify.mockReset().mockResolvedValue(true);
    hash.mockReset().mockResolvedValue('new-hash');

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChangePasswordHandler,
        { provide: CommandBus, useValue: { execute: dispatch } },
        { provide: QueryBus, useValue: { execute: query } },
        { provide: PasswordService, useValue: { verify, hash } },
      ],
    }).compile();

    handler = moduleRef.get(ChangePasswordHandler);
  });

  describe('with the correct current password', () => {
    it('hashes the new password and hands the hash to the user module', async () => {
      await change();

      expect(query).toHaveBeenCalledWith(new FindUserCredentialsByIdQuery('user-id'));
      expect(verify).toHaveBeenCalledWith('stored-hash', CURRENT);
      expect(hash).toHaveBeenCalledWith(NEW);
      expect(dispatch).toHaveBeenCalledWith(new UpdatePasswordHashCommand('user-id', 'new-hash'));
    });

    it('never sends a raw password across the module boundary', async () => {
      await change();

      // The whole point of `UpdatePasswordHashCommand` carrying a hash. A regression here
      // would be invisible in an e2e test, which only sees the 204.
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain(NEW);
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain(CURRENT);
    });

    it.each([
      ['exactly the minimum length', 'x'.repeat(MIN_PASSWORD_LENGTH)],
      ['exactly the maximum length', 'x'.repeat(MAX_PASSWORD_LENGTH)],
      ['leading and trailing spaces around real characters', '  spaces kept  '],
    ])('accepts a new password of %s', async (_description, newPassword) => {
      await change(CURRENT, newPassword);

      // Not trimmed, unlike a display name: a password is the bytes the user typed, and
      // trimming one would silently change the credential they chose.
      expect(hash).toHaveBeenCalledWith(newPassword);
      expect(dispatch).toHaveBeenCalled();
    });
  });

  describe('rejecting the change', () => {
    it('answers a wrong current password with the shared 401 message', async () => {
      verify.mockResolvedValue(false);

      await expect(change()).rejects.toThrow(new UnauthorizedException(CURRENT_PASSWORD_MESSAGE));
      expect(hash).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('answers a new password equal to the current one with the shared 400 message', async () => {
      await expect(change(CURRENT, CURRENT)).rejects.toThrow(
        new BadRequestException(PASSWORD_UNCHANGED_MESSAGE),
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('checks the current password before it says whether a value is unchanged', async () => {
      // Otherwise the endpoint tells anyone holding a stolen token whether a guessed password
      // is the account's current one — the one fact it must not hand out.
      verify.mockResolvedValue(false);

      await expect(change(CURRENT, CURRENT)).rejects.toThrow(
        new UnauthorizedException(CURRENT_PASSWORD_MESSAGE),
      );
    });

    it.each([
      ['one character under the minimum', 'x'.repeat(MIN_PASSWORD_LENGTH - 1)],
      ['one character over the maximum', 'x'.repeat(MAX_PASSWORD_LENGTH + 1)],
      ['blank', ''],
      ['nothing but spaces', ' '.repeat(MIN_PASSWORD_LENGTH + 2)],
    ])('rejects a new password that is %s, and stores nothing', async (_description, value) => {
      await expect(change(CURRENT, value)).rejects.toThrow(
        new BadRequestException(NEW_PASSWORD_MESSAGE),
      );
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('rejects a bad new password before it reads the stored hash', async () => {
      // The DTO refused this value already; the handler restating the rule is what makes the
      // command safe whatever dispatched it, and there is no reason to touch the database.
      await expect(change(CURRENT, 'short')).rejects.toThrow(BadRequestException);
      expect(query).not.toHaveBeenCalled();
    });

    it('answers a token whose subject is gone with a bare 401', async () => {
      query.mockResolvedValue(null);

      const error = await change().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnauthorizedException);
      // Not the current-password sentence: nothing has been said about the password, and the
      // browser reads that sentence as "wrong password" rather than "signed out".
      expect((error as UnauthorizedException).message).not.toBe(CURRENT_PASSWORD_MESSAGE);
      expect(verify).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
