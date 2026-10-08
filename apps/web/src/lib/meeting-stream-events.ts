import type { MeetingDigest, MeetingFile } from '@repo/shared';

/** The `event:` name the API sends a changed file under. */
export const FILE_EVENT = 'file';
/**
 * The name it sends the meeting's digest under, on the same stream: the digest read again
 * after a write to it. Anything that is neither is a heartbeat.
 */
export const DIGEST_EVENT = 'digest';

/** Who is told about each of the two things a meeting's stream carries. */
export interface StreamConsumers {
  onFile(file: MeetingFile): void;
  /** Absent for a caller that follows the files alone, which reads past digest events. */
  onDigest?: ((digest: MeetingDigest) => void) | undefined;
}

/**
 * Hands one event of a meeting's stream to the consumer its name belongs to.
 *
 * Each name has a reader of its own, and an event that fits neither — a heartbeat, a name a
 * newer API added — is passed over. **A payload its reader cannot make sense of is dropped
 * rather than thrown**: one unreadable event must not end a stream that is otherwise
 * working, and the next fetch sees whatever it described anyway.
 */
export function deliverStreamEvent(
  event: { type: string; data: string },
  { onFile, onDigest }: StreamConsumers,
): void {
  if (event.type === DIGEST_EVENT) {
    const digest = parseDigest(event.data);

    if (digest !== null) {
      onDigest?.(digest);
    }

    return;
  }

  if (event.type !== FILE_EVENT) {
    return;
  }

  const file = parseFile(event.data);

  if (file !== null) {
    onFile(file);
  }
}

/** JSON that parsed to an object, or `null` for anything else — unreadable text included. */
function parseObject(data: string): object | null {
  try {
    const parsed: unknown = JSON.parse(data);

    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** A file is recognised by its `id`, which is what `applyFileEvent` places it by. */
function parseFile(data: string): MeetingFile | null {
  const parsed = parseObject(data);

  return parsed !== null && 'id' in parsed ? (parsed as MeetingFile) : null;
}

/**
 * A digest is recognised by the two fields the page orders it by: whose meeting, and which
 * version.
 */
function parseDigest(data: string): MeetingDigest | null {
  const parsed = parseObject(data);

  return parsed !== null &&
    'meetingId' in parsed &&
    typeof parsed.meetingId === 'string' &&
    'version' in parsed &&
    typeof parsed.version === 'number'
    ? (parsed as MeetingDigest)
    : null;
}
