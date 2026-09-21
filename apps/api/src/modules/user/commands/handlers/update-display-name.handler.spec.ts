import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DISPLAY_NAME_MESSAGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
} from '@repo/shared';

import { Prisma } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateDisplayNameCommand } from '../update-display-name.command';
import { UpdateDisplayNameHandler } from './update-display-name.handler';

describe('UpdateDisplayNameHandler', () => {
  const update = jest.fn();
  let handler: UpdateDisplayNameHandler;

  beforeEach(async () => {
    update.mockReset().mockImplementation(({ data }: { data: { displayName: string } }) =>
      Promise.resolve({
        id: 'user-id',
        email: 'ada+test@example.com',
        displayName: data.displayName,
        avatarKey: null,
        avatarVersion: 0,
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
        passwordHash: 'hashed-password',
      }),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        UpdateDisplayNameHandler,
        { provide: PrismaService, useValue: { user: { update } } },
      ],
    }).compile();

    handler = moduleRef.get(UpdateDisplayNameHandler);
  });

  it('stores the trimmed name against the caller from the command', async () => {
    await handler.execute(new UpdateDisplayNameCommand('user-id', '   Ada Lovelace   '));

    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: { displayName: 'Ada Lovelace' },
    });
  });

  it('returns the public user with the trimmed name, never the stored hash', async () => {
    const user = await handler.execute(new UpdateDisplayNameCommand('user-id', '  Ada Lovelace  '));

    expect(user).toEqual({
      id: 'user-id',
      email: 'ada+test@example.com',
      displayName: 'Ada Lovelace',
      avatarVersion: 0,
      createdAt: '2026-07-30T12:00:00.000Z',
    });
    expect(user).not.toHaveProperty('passwordHash');
  });

  // The handler's own invariant, not the DTO's: a command has to be safe whatever dispatched
  // it, so each rejection is asserted here as well as over HTTP. Every one of them must also
  // leave the row alone — a name the handler refuses is a name it must not have written.
  it.each([
    ['a blank name', ''],
    ['a whitespace-only name', '   '],
    ['a name over the maximum once trimmed', `  ${'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)}  `],
    ['a name one emoji over the maximum', '\u{1F600}'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)],
  ])('rejects %s with the shared message and writes nothing', async (_case, displayName) => {
    await expect(
      handler.execute(new UpdateDisplayNameCommand('user-id', displayName)),
    ).rejects.toThrow(new BadRequestException(DISPLAY_NAME_MESSAGE));

    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['the minimum', 'a'.repeat(MIN_DISPLAY_NAME_LENGTH)],
    ['the maximum', 'a'.repeat(MAX_DISPLAY_NAME_LENGTH)],
    // Two UTF-16 code units apiece: `.length` would call this 160 and refuse what the DTO
    // had just accepted, with a message saying it was too long.
    ['the maximum in emoji', '\u{1F600}'.repeat(MAX_DISPLAY_NAME_LENGTH)],
  ])('accepts a name of exactly %s, padded past it', async (_case, name) => {
    // Trim-then-measure is what makes the padding irrelevant: a name is rejected for what
    // would be stored, never for characters that were never going to be.
    const user = await handler.execute(new UpdateDisplayNameCommand('user-id', `    ${name}    `));

    expect(user.displayName).toBe(name);
  });

  it('answers 401 when the row is gone, the guard rule arriving one step later', async () => {
    update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Record to update not found', {
        code: 'P2025',
        clientVersion: '7.9.1',
      }),
    );

    await expect(
      handler.execute(new UpdateDisplayNameCommand('user-id', 'Ada Lovelace')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lets any other database error through untouched', async () => {
    update.mockRejectedValue(new Error('connection reset'));

    await expect(
      handler.execute(new UpdateDisplayNameCommand('user-id', 'Ada Lovelace')),
    ).rejects.toThrow('connection reset');
  });
});
