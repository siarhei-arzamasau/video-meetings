import type { ProcessingStep } from './step';
import { PreviewStep } from './steps/preview.step';
import { VerifyStep } from './steps/verify.step';

/**
 * The ordered step list, and the promise the PRD's F8 makes: adding a step is one entry here,
 * and neither the state machine nor the API changes for it. Verify runs first so nothing
 * downstream reads an object that is not whole.
 *
 * A step with dependencies is built by the module instead — `buildPipeline` below — because
 * these two have none and constructing them here keeps the list readable.
 * `QueueTranscriptionStep` needs `ConfigService`, so it arrives as an argument rather than a
 * `new` call this file could not make.
 */
export const PIPELINE: ReadonlyArray<ProcessingStep> = [new VerifyStep(), new PreviewStep()];

/**
 * The pipeline the application runs: the two stateless steps, then the one that queues a
 * recording for transcription. **Last, and it has to stay last**: its patch must only ever be
 * merged into a `ready` write, so no step may run — and fail — after it has asked.
 */
export function buildPipeline(queueTranscription: ProcessingStep): ReadonlyArray<ProcessingStep> {
  return [...PIPELINE, queueTranscription];
}
