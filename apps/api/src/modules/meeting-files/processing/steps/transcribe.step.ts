import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { transcriptKeyOf } from '../../services/meeting-file.mapper';
import { TRANSCRIPTION_PROVIDER } from '../transcription/transcription-provider';
import type { TranscriptionProvider } from '../transcription/transcription-provider';
import type { ProcessingStep, StepContext, StepPatch } from '../step';

/** What the step transcribes. Anything else is not a recording and is skipped, not failed. */
const TRANSCRIBABLE = ['audio/', 'video/'];

/**
 * The platform's first AI step: a transcript beside the object, for audio and video only.
 *
 * Three things about it are deliberate.
 *
 * **The flag is read per tick, not at boot.** Turning transcription on is a configuration
 * change, not a deployment, so this asks `ConfigService` every time it runs.
 *
 * **A skip is not a failure.** A PDF, or any file uploaded while the flag was off, reaches
 * `ready` with no transcript and no reason — the pipeline's contract is that a step which has
 * nothing to do returns an empty patch. Turning the flag on later does not reprocess those
 * files; a retry does, one file at a time.
 *
 * **The provider never sees a path.** The object is opened by key through `MeetingFileStorage`
 * and streamed; what comes back is text, which is written back by key. Nothing in this step
 * joins a path, and the transcript's key is derived from the object's, never from a name.
 */
@Injectable()
export class TranscribeStep implements ProcessingStep {
  readonly name = 'transcribe';

  constructor(
    private readonly config: ConfigService,
    @Inject(TRANSCRIPTION_PROVIDER) private readonly provider: TranscriptionProvider,
  ) {}

  async run({ record, storage, logger }: StepContext): Promise<StepPatch> {
    if (!this.config.get<boolean>('MEETING_FILES_TRANSCRIPTION_ENABLED', false)) {
      return {};
    }

    if (!TRANSCRIBABLE.some((prefix) => record.contentType.startsWith(prefix))) {
      return {};
    }

    const seconds = this.config.get<number>('TRANSCRIPTION_TIMEOUT_SECONDS', 600);
    const startedAt = Date.now();
    const stream = storage.openRead(record.storageKey);
    // A read failure reaches the provider through the stream it is consuming, and comes back
    // as a `StepError`. This listener is for the other case: a stream nobody is reading —
    // because the provider returned early, or because the purge removed the object while the
    // request was in flight — whose `error` event would otherwise be unhandled and take the
    // process with it.
    stream.on('error', () => undefined);
    let text: string;

    try {
      // The provider's own bound. A request that outruns it is aborted and becomes a
      // StepError with a specific reason, rather than a worker holding a lease it keeps
      // renewing.
      text = await this.provider.transcribe(
        stream,
        record.contentType,
        AbortSignal.timeout(seconds * 1_000),
      );
    } finally {
      // The step opened it, so the step closes it — idempotent, and it costs nothing when the
      // provider has read the stream to its end. A provider that returned without touching
      // it would otherwise leak a descriptor per recording.
      stream.destroy();
    }

    const transcriptKey = transcriptKeyOf(record.storageKey);

    await storage.writeText(transcriptKey, text);
    logger.log(
      `File ${record.id} of meeting ${record.meetingId}: transcribed ${String(record.size)} bytes of ${record.contentType} into ${String(text.length)} characters in ${String(Date.now() - startedAt)}ms`,
    );

    return { transcriptKey };
  }
}
