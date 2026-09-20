import type { StepPatch } from './step';

/** Carries the patch accumulated before `step` threw, and the cause, which decides the reason. */
export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly patch: StepPatch,
    override readonly cause: unknown,
  ) {
    super(`Step ${step} failed`);
    this.name = 'StepFailure';
  }
}

/** Whatever the steps before the failing one produced — kept, never discarded on a failure. */
export function patchBefore(error: unknown): StepPatch {
  return error instanceof StepFailure ? error.patch : {};
}
