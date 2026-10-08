/**
 * Resolves to the ids of everyone in the meeting — its host first, then its participants —
 * or `null` when no meeting has that id.
 *
 * **It carries no user and checks no visibility**: who may ask about the meeting is the
 * caller's to have decided. It exists for a caller that has no user at all — the digest
 * worker, deciding which member a spoken name identifies — and is a query of its own rather
 * than a wider `FindVisibleMeetingQuery`, which runs on every file route and must stay the
 * two columns it is.
 *
 * Ids and nothing else: a member's name is the user module's to answer.
 */
export class FindMeetingMemberIdsQuery {
  constructor(readonly meetingId: string) {}
}
