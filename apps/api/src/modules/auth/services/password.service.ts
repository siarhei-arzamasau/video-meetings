import { randomUUID } from 'node:crypto';

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Options as Argon2Options } from '@node-rs/argon2';

/**
 * OWASP's argon2id configuration: 19 MiB, two passes, one lane. It is also what the library
 * does by default, but its own typings document 4 MiB and three passes, so nobody reading the
 * code could tell — and a default can move under a version bump without anyone deciding it
 * should. Stated here, the choice is visible and only changes on purpose.
 */
const ARGON2_OPTIONS: Argon2Options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

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
    // the enumeration the shared login error message is there to prevent. Made by `hash`,
    // because a verification costs what its hash's parameters say: a dummy made any other
    // way could be cheaper than a stored hash, and a miss would answer faster than a hit.
    this.dummyHash = await this.hash(randomUUID());
  }

  hash(password: string): Promise<string> {
    return argon2Hash(password, ARGON2_OPTIONS);
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
