import type { ProcessingStep, StepContext, StepPatch } from './step';

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

/**
 * Runs the steps in order, accumulating the patch. A throw carries the patch so far on it,
 * so a later failure does not discard an earlier step's result.
 */
export function runSteps(
  steps: ReadonlyArray<ProcessingStep>,
  context: StepContext,
): Promise<StepPatch> {
  return steps.reduce<Promise<StepPatch>>(async (previous, step) => {
    const patch = await previous;

    try {
      return { ...patch, ...(await step.run(context)) };
    } catch (error) {
      throw new StepFailure(step.name, patch, error);
    }
  }, Promise.resolve({}));
}
