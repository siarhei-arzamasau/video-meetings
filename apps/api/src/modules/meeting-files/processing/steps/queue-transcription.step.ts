import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import type { ProcessingStep, StepContext, StepPatch } from '../step';

/** What counts as a recording. Anything else gets no transcription status at all. */
const RECORDING_TYPE_PREFIXES = ['audio/', 'video/'];

/**
 * The pipeline's last step, and the only thing the file's own processing has to do with
 * transcription: it decides whether this file is one to transcribe, and says so in the patch.
 *
 * It transcribes nothing. The worker merges a step's patch into the `processing → ready`
 * write, so returning `QUEUED` here makes "ready" and "queued" one statement and one event:
 * a file that fails any earlier step never gets a status, a retried file gets one when it
 * finally reaches `ready`, and a file processed while the setting was off never does —
 * switching it on later queues nothing that is already `ready`.
 *
 * The setting is asked for on every run rather than once in the constructor, which is what
 * lets the e2e suite flip it through `ConfigService.set` between tests.
 */
@Injectable()
export class QueueTranscriptionStep implements ProcessingStep {
  readonly name = 'queue-transcription';

  constructor(private readonly config: ConfigService) {}

  run({ record }: StepContext): Promise<StepPatch> {
    const enabled = this.config.get<boolean>('MEETING_FILES_TRANSCRIPTION_ENABLED', false);
    const isRecording = RECORDING_TYPE_PREFIXES.some((prefix) =>
      record.contentType.startsWith(prefix),
    );

    return Promise.resolve(
      enabled && isRecording ? { transcriptionStatus: TranscriptionStatus.QUEUED } : {},
    );
  }
}
