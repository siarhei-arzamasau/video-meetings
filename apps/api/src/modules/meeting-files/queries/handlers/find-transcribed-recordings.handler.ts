import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { FindTranscribedRecordingsQuery } from '../find-transcribed-recordings.query';
import type { TranscribedRecording } from '../find-transcribed-recordings.query';

@QueryHandler(FindTranscribedRecordingsQuery)
export class FindTranscribedRecordingsHandler implements IQueryHandler<
  FindTranscribedRecordingsQuery,
  TranscribedRecording[]
> {
  constructor(private readonly transcriptions: MeetingFileTranscriptionRepository) {}

  async execute({ meetingId }: FindTranscribedRecordingsQuery): Promise<TranscribedRecording[]> {
    const recordings = await this.transcriptions.findTranscribedOf(meetingId);

    // The storage key stays on this side of the boundary: a caller has no use for a path.
    return recordings.map(({ id, uploaderId }) => ({ id, uploaderId }));
  }
}
