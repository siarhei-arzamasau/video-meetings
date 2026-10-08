import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * The stored digest vocabulary, restated rather than imported for the reason `fixtures.ts`
 * restates everything else: a spec that spelt a status out of the application's own constant
 * would keep passing the day the stored value changed.
 */
export const QUEUED = 'QUEUED';
export const GENERATING = 'GENERATING';
export const READY = 'READY';
export const FAILED = 'FAILED';

/**
 * Reads and seeds the digest tables over raw SQL, as every table helper here does: the specs
 * pin the table and column names, and assert what was written rather than what the API says
 * was. The schema must map to **`meeting_digests`** — one row per meeting, a
 * **`meeting_digest_status`** enum whose values are UPPER_CASE — and to
 * **`meeting_digest_action_items`**, **`meeting_digest_decisions`**, and
 * **`meeting_digest_sources`**, each keyed to it by `digest_id`.
 *
 * No truncation helper: `truncateUsers` cascades through `meetings` to all four.
 */
export interface MeetingDigestRow {
  id: string;
  meeting_id: string;
  status: string | null;
  failure_reason: string | null;
  attempts: number;
  leased_until: string | null;
  requested_revision: number;
  version: number;
  summary: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The meeting's digest row as `to_jsonb` renders it, every column included, or `null`. */
export async function findMeetingDigestRow(
  prisma: PrismaService,
  meetingId: string,
): Promise<MeetingDigestRow | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: MeetingDigestRow }>>(
    'SELECT to_jsonb(d) AS row FROM "meeting_digests" d WHERE meeting_id = $1::uuid',
    meetingId,
  );

  return rows[0]?.row ?? null;
}

export interface MeetingDigestContentRows {
  actionItems: Array<{ description: string; owner_name: string | null; owner_id: string | null }>;
  decisions: string[];
  /** The ids of the recordings the content was generated from, sorted. */
  sources: string[];
}

/** What is stored under a meeting's digest, the lists in the order they are shown in. */
export async function findMeetingDigestContentRows(
  prisma: PrismaService,
  meetingId: string,
): Promise<MeetingDigestContentRows> {
  const under = (table: string, columns: string, order: string): Promise<unknown[]> =>
    prisma.$queryRawUnsafe(
      `SELECT ${columns} FROM "${table}" t
       JOIN "meeting_digests" d ON d.id = t.digest_id
       WHERE d.meeting_id = $1::uuid ORDER BY ${order}`,
      meetingId,
    );
  const [actionItems, decisions, sources] = await Promise.all([
    under('meeting_digest_action_items', 't.description, t.owner_name, t.owner_id', 't.position'),
    under('meeting_digest_decisions', 't.description', 't.position'),
    under('meeting_digest_sources', 't.meeting_file_id', 't.meeting_file_id'),
  ]);

  return {
    actionItems: actionItems as MeetingDigestContentRows['actionItems'],
    decisions: (decisions as Array<{ description: string }>).map(({ description }) => description),
    sources: (sources as Array<{ meeting_file_id: string }>).map((row) => row.meeting_file_id),
  };
}

export interface MeetingDigestState {
  status?: string | null;
  attempts?: number;
  leased_until?: Date | null;
  failure_reason?: string | null;
}

/**
 * Moves a digest into a state no route can produce on demand: a claim whose worker died
 * (`GENERATING` with a lease in the past), a claim count at the cap.
 */
export async function setMeetingDigestState(
  prisma: PrismaService,
  meetingId: string,
  state: MeetingDigestState,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [meetingId];

  const set = (column: string, value: unknown, cast = ''): void => {
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}${cast}`);
  };

  if (state.status !== undefined) {
    set('status', state.status, '::meeting_digest_status');
  }
  if (state.attempts !== undefined) {
    set('attempts', state.attempts);
  }
  if (state.leased_until !== undefined) {
    set('leased_until', state.leased_until);
  }
  if (state.failure_reason !== undefined) {
    set('failure_reason', state.failure_reason);
  }

  if (assignments.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "meeting_digests" SET ${assignments.join(', ')} WHERE meeting_id = $1::uuid`,
    ...values,
  );
}
