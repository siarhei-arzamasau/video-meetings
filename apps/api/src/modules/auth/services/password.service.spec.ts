import { Test } from '@nestjs/testing';

import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let passwords: PasswordService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PasswordService],
    }).compile();

    passwords = moduleRef.get(PasswordService);
    await passwords.onModuleInit();
  });

  it('hashes with argon2id and verifies the original password', async () => {
    const passwordHash = await passwords.hash('correct horse battery');

    expect(passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(passwordHash, 'correct horse battery')).toBe(true);
  });

  it('rejects a different password', async () => {
    const passwordHash = await passwords.hash('correct horse battery');

    expect(await passwords.verify(passwordHash, 'wrong horse battery')).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('verifies against the dummy hash without throwing', async () => {
    await expect(passwords.verifyDummy('anything')).resolves.toBeUndefined();
  });
});
