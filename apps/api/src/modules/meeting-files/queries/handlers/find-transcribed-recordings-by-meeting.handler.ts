import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { FindTranscribedRecordingsByMeetingQuery } from '../find-transcribed-recordings-by-meeting.query';
import type { MeetingTranscribedRecordings } from '../find-transcribed-recordings-by-meeting.query';

@QueryHandler(FindTranscribedRecordingsByMeetingQuery)
export class FindTranscribedRecordingsByMeetingHandler implements IQueryHandler<
  FindTranscribedRecordingsByMeetingQuery,
  MeetingTranscribedRecordings[]
> {
  constructor(private readonly transcriptions: MeetingFileTranscriptionRepository) {}

  async execute(): Promise<MeetingTranscribedRecordings[]> {
    const recordings = await this.transcriptions.findAllTranscribed();
    const fileIdsByMeeting = new Map<string, string[]>();

    // The rows come in upload order, so each meeting's ids are in the order its own read
    // gives them, and the meetings in the order of their first recording.
    for (const { id, meetingId } of recordings) {
      const fileIds = fileIdsByMeeting.get(meetingId);

      if (fileIds === undefined) {
        fileIdsByMeeting.set(meetingId, [id]);
      } else {
        fileIds.push(id);
      }
    }

    return [...fileIdsByMeeting].map(([meetingId, fileIds]) => ({ meetingId, fileIds }));
  }
}
