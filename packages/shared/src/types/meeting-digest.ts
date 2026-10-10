import type { Meeting } from './meeting';
import { describeTimeLimit } from './time-limit';
import type { User } from './user';

/**
 * Where the latest generation of a meeting's digest stands. A status of its own, beside every
 * file's and every transcription's: no upload and no transcript waits for a digest or fails
 * with one.
 */
export const MEETING_DIGEST_STATUSES = ['queued', 'generating', 'ready', 'failed'] as const;

export type MeetingDigestStatus = (typeof MEETING_DIGEST_STATUSES)[number];

/**
 * What `POST /api/meetings/:id/digest/generation` would do for a digest as it stands, and so
 * what the control that sends it is called: `retry`, for a digest that failed. It is the
 * one thing a person asks for — every other digest is generated with nobody asking, when a
 * recording is transcribed or when the API next starts.
 */
export const MEETING_DIGEST_ACTIONS = ['retry'] as const;

export type MeetingDigestAction = (typeof MEETING_DIGEST_ACTIONS)[number];

/**
 * Who an action item belongs to, when the transcripts named someone. A `participant` is the
 * meeting's host or one of its participants, under their current display name; a `name` is
 * what was spoken, linked to nobody. The API decides which — never the model — and links a
 * name only when it identifies exactly one member of the meeting.
 *
 * **A participant's `displayName` is the one thing here that can change under an unchanged
 * `version`**: it is read when the digest is, and a rename writes nothing to the digest. A
 * client that holds a digest should take a fetched one of the same version over it.
 */
export type MeetingDigestOwner =
  | { kind: 'participant'; userId: User['id']; displayName: string }
  | { kind: 'name'; name: string };

/** What a generation stored. Every string is the model's: render it as text, never as markup. */
export interface MeetingDigestContent {
  summary: string;
  /** `owner` absent: unassigned. */
  actionItems: ReadonlyArray<{ id: string; description: string; owner?: MeetingDigestOwner }>;
  decisions: ReadonlyArray<{ id: string; description: string }>;
  /** ISO 8601 instant, UTC. */
  generatedAt: string;
  /** A transcribed recording of the meeting is not among those this was built from. */
  outOfDate: boolean;
}

/** A meeting's digest, as `GET /api/meetings/:id/digest` reports it. */
export interface MeetingDigest {
  meetingId: Meeting['id'];
  /**
   * Rises with every change below but two — a linked owner's new display name, and an
   * `availableAction` that left with a recording nothing reacted to the delete of; a client
   * keeps the higher. 0: the meeting never had one.
   */
  version: number;
  /** Where the latest generation stands. Absent when none has been asked for. */
  status?: MeetingDigestStatus;
  /** Present only when `status` is `failed`. Safe to render. */
  failureReason?: string;
  /** Present only while every recording it was built from still exists. */
  content?: MeetingDigestContent;
  /**
   * What the meeting's host, or the uploader of one of its transcribed recordings, may ask
   * for now: to retry a digest that failed. Absent for every other digest — one that is
   * current, queued, or generating, and one that is simply not there yet, which nobody has
   * to ask for — for a meeting with no transcribed recording, and for every meeting while
   * the deployment has digests switched off.
   *
   * **The same for everyone who reads the digest**: it says what the digest allows, not
   * whether this reader may ask. The API answers anyone else's request with 404.
   *
   * **It can go away under an unchanged `version`**, when the last transcribed recording of
   * a meeting whose digest failed is deleted and nothing has yet reacted to the delete. A
   * client offers the action only while it also holds a transcribed recording of the
   * meeting, and answers a 409 from the request by fetching the digest again.
   */
  availableAction?: MeetingDigestAction;
}

/**
 * Why a digest failed, as the API stores it in `failureReason`. Fixed copy, chosen by the API
 * from what happened and never from what the Claude Agent SDK or Anthropic said: their own
 * error text stays in the server log. The first is also the web app's fallback for a `failed`
 * digest that carries no reason.
 */
export const MEETING_DIGEST_FAILED_MESSAGE = 'The digest could not be generated.';
export const MEETING_DIGEST_REPEATED_FAILURE_MESSAGE =
  'The digest could not be generated after repeated attempts.';
/**
 * The transcripts are together more than one request can carry. They are sent whole or not at
 * all: a digest of part of a meeting is never offered as the digest of the meeting.
 */
export const MEETING_DIGEST_TOO_LONG_MESSAGE =
  'The recordings of this meeting are too long to turn into one digest.';

/**
 * The reason for a generation that outran the deployment's time limit, naming that limit:
 * `the 4-minute limit` for a whole number of minutes, `the 90-second limit` otherwise.
 */
export function meetingDigestTimeLimitMessage(limitSeconds: number): string {
  return `Generating the digest took longer than the ${describeTimeLimit(limitSeconds)} limit.`;
}
