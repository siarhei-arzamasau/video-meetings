import type { QueryBus } from '@nestjs/cqrs';

import { FindMeetingTranscriptsQuery } from '../../meeting-files/queries/find-meeting-transcripts.query';
import type { MeetingTranscripts } from '../../meeting-files/queries/find-meeting-transcripts.query';
import { FindTranscribedRecordingsQuery } from '../../meeting-files/queries/find-transcribed-recordings.query';
import type { TranscribedRecording } from '../../meeting-files/queries/find-transcribed-recordings.query';
import { MAX_DIGEST_TRANSCRIPT_CHARACTERS } from '../meeting-digest.constants';

/**
 * The two things the digest's background work asks `meeting-files` about one meeting, over
 * the bus: what was said in its recordings, and which of them are transcribed now. Neither
 * is a table it reads.
 */

/** The meeting's transcripts in upload order, or the fact that they are past the cap. */
export function transcriptsOf(queryBus: QueryBus, meetingId: string): Promise<MeetingTranscripts> {
  return queryBus.execute<FindMeetingTranscriptsQuery, MeetingTranscripts>(
    new FindMeetingTranscriptsQuery(meetingId, MAX_DIGEST_TRANSCRIPT_CHARACTERS),
  );
}

/**
 * The ids of the meeting's transcribed recordings: what an answer's sources are held to,
 * and what the catch-up decides a meeting's turn by.
 */
export async function transcribedIdsOf(queryBus: QueryBus, meetingId: string): Promise<string[]> {
  const recordings = await queryBus.execute<FindTranscribedRecordingsQuery, TranscribedRecording[]>(
    new FindTranscribedRecordingsQuery(meetingId),
  );

  return recordings.map(({ id }) => id);
}
