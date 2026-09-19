import { createHash } from 'node:crypto';

import { StepError } from '../step';
import type { ProcessingStep, StepContext, StepPatch } from '../step';

export const INCOMPLETE_MESSAGE = 'The stored file is incomplete';

/**
 * Re-reads the stored object: the size must match the record — a truncated write is caught
 * here — and the SHA-256 goes on the record so a later read can be checked against it.
 */
export class VerifyStep implements ProcessingStep {
  readonly name = 'verify';

  async run({ record, storage }: StepContext): Promise<StepPatch> {
    const { size } = await storage.stat(record.storageKey);

    if (size !== record.size) {
      throw new StepError(INCOMPLETE_MESSAGE);
    }

    const hash = createHash('sha256');

    for await (const chunk of storage.openRead(record.storageKey)) {
      hash.update(chunk);
    }

    return { checksum: hash.digest('hex') };
  }
}
