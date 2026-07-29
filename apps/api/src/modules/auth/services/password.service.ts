import { randomUUID } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * argon2id hashing plus the timing half of the account-enumeration defence. Both live here
 * so a login path that forgets to spend the dummy work is a missing call to a documented
 * method rather than a subtly absent line.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    // Verified against when no account matches, so a miss costs the same as a hit. Without
    // it, argon2 runs only on the hit path and response time leaks which emails exist —
    // the enumeration the shared login error message is there to prevent.
    this.dummyHash = await argon2Hash(randomUUID());
  }

  hash(password: string): Promise<string> {
    return argon2Hash(password);
  }

  /** argon2 raises on a malformed hash, which for a login attempt just means "no". */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Spends a verification's worth of work when there is no account to verify against. */
  async verifyDummy(password: string): Promise<void> {
    await this.verify(this.dummyHash, password);
  }
}
