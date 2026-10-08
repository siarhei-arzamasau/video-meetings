/** One recording's transcript, whole. Blank when nothing was heard in it. */
export interface MeetingTranscript {
  fileId: string;
  text: string;
}

/**
 * Every transcript of a meeting, or the fact that together they are more than was asked for.
 * Never part of them: a caller that got some of a meeting's text could mistake it for all.
 */
export type MeetingTranscripts =
  | { withinLimit: true; transcripts: ReadonlyArray<MeetingTranscript> }
  | { withinLimit: false };

/**
 * Resolves to the transcripts of a meeting's transcribed recordings, in upload order — the
 * recordings `FindTranscribedRecordingsQuery` names, with their text.
 *
 * **`maxCharacters` bounds what is loaded, not what is returned.** A meeting holds up to
 * fifty recordings of up to a gigabyte each, so its transcripts are not bounded by anything
 * else; the handler stops reading at the limit and answers `withinLimit: false` instead of
 * holding text nobody can use. Characters are a string's `length`, which is how the caller's
 * own cap counts them.
 *
 * Like the query beside it, it carries no user: the caller has decided who may ask.
 */
export class FindMeetingTranscriptsQuery {
  constructor(
    readonly meetingId: string,
    readonly maxCharacters: number,
  ) {}
}
