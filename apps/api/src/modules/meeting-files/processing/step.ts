import type { Logger } from '@nestjs/common';

import type { MeetingFileRecord } from '../services/meeting-file.mapper';
import type { MeetingFileStorage } from '../storage/meeting-file-storage';

export interface StepContext {
  record: MeetingFileRecord;
  storage: MeetingFileStorage;
  logger: Logger;
  /**
   * Aborted when the worker is shutting down. A step that waits on anything outside the
   * process — a third party, most of all — must honour it, so a stopping process lets go at
   * once instead of holding on for as long as the step's own timeout allows. The worker
   * treats a throw after this fires as a release, not a failure: the row goes back to
   * `uploaded` for the next claim.
   */
  signal: AbortSignal;
}

/** The subset of columns a step may set. Merged into the `ready` transition. */
export interface StepPatch {
  checksum?: string;
  thumbnailKey?: string;
  transcriptKey?: string;
}

export interface ProcessingStep {
  readonly name: string;
  run(context: StepContext): Promise<StepPatch>;
}

/**
 * A failure with a message safe to show a user. Only a `StepError`'s `userMessage` reaches
 * `failureReason`; any other throw stores the generic copy and is logged with its stack.
 */
export class StepError extends Error {
  constructor(
    readonly userMessage: string,
    options?: ErrorOptions,
  ) {
    super(userMessage, options);
    this.name = 'StepError';
  }
}
