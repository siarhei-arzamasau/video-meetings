/** One meeting's transcribed recordings, by file id, in upload order. */
export interface MeetingTranscribedRecordings {
  meetingId: string;
  fileIds: string[];
}

/**
 * Resolves to every meeting that has a transcribed recording, each with those recordings —
 * `FindTranscribedRecordingsQuery` for all meetings at once, under exactly its conditions. A
 * meeting with none is not in the answer.
 *
 * For a caller that has to look across meetings without reading this module's table: the
 * digest's catch-up, which compares these with what each stored digest was built from. That
 * comparison is why the conditions must not drift from the single-meeting read's — a
 * recording one of them counts and the other does not is a digest that never looks current.
 *
 * **It carries no user and checks no visibility, and it must never be dispatched for a
 * request.** It names every meeting that has a recording; the one-meeting query at least has
 * a visibility check that can stand in front of it.
 */
// oxlint-disable-next-line typescript/no-extraneous-class -- nothing to ask with: the bus routes a query by its class, so a query with no parameter is still one
export class FindTranscribedRecordingsByMeetingQuery {}
