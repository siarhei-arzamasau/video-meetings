import type { ProcessingStep } from './step';
import { PreviewStep } from './steps/preview.step';
import { VerifyStep } from './steps/verify.step';

/**
 * The ordered step list. Adding a step is one entry here; neither the state machine nor the
 * API changes. Verify runs first so nothing downstream reads an object that is not whole.
 */
export const PIPELINE: ReadonlyArray<ProcessingStep> = [new VerifyStep(), new PreviewStep()];
