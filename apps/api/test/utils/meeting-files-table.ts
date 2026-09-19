import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * Reads and seeds the meeting files table over raw SQL rather than through
 * `prisma.meetingFile`, for the reasons `users-table.ts` and `meetings-table.ts` give: the
 * specs compile before the model exists, and they assert the storage contract rather than the
 * client's view of it.
 *
 * The schema must map to **`meeting_files`** with **snake_case** columns and a
 * **`meeting_file_status`** enum:
 *
 * ```prisma
 * model MeetingFile {
 *   id            String            @id @default(uuid())
 *   meetingId     String            @map("meeting_id")
 *   uploaderId    String            @map("uploader_id")
 *   name          String
 *   contentType   String            @map("content_type")
 *   size          Int
 *   storageKey    String            @unique @map("storage_key")
 *   checksum      String?
 *   thumbnailKey  String?           @map("thumbnail_key")
 *   status        MeetingFileStatus @default(uploaded)
 *   failureReason String?           @map("failure_reason")
 *   attempts      Int               @default(0)
 *   leasedUntil   DateTime?         @map("leased_until")
 *   createdAt     DateTime          @default(now()) @map("created_at")
 *   processedAt   DateTime?         @map("processed_at")
 *   deletedAt     DateTime?         @map("deleted_at")
 *   purgedAt      DateTime?         @map("purged_at")
 *
 *   @@map("meeting_files")
 * }
 * ```
 *
 * No truncation helper, as with `meetings-table.ts`: `truncateUsers` cascades here too.
 */
export interface MeetingFileRow {
  id: string;
  meeting_id: string;
  uploader_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
  checksum: string | null;
  thumbnail_key: string | null;
  status: string;
  failure_reason: string | null;
  attempts: number;
  leased_until: string | null;
  created_at: string;
  processed_at: string | null;
  deleted_at: string | null;
  purged_at: string | null;
}

/**
 * Every row, oldest first, as `to_jsonb` renders it — every column included, so a "nothing
 * changed" comparison cannot miss a column it did not think to select. Timestamps therefore
 * arrive as ISO strings rather than `Date`s.
 */
export async function findMeetingFileRows(prisma: PrismaService): Promise<MeetingFileRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: MeetingFileRow }>>(
    'SELECT to_jsonb(f) AS row FROM "meeting_files" f ORDER BY created_at, id',
  );

  return rows.map(({ row }) => row);
}

/** The single row for an id. Fails loudly rather than returning undefined. */
export async function findMeetingFileRow(
  prisma: PrismaService,
  id: string,
): Promise<MeetingFileRow> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: MeetingFileRow }>>(
    'SELECT to_jsonb(f) AS row FROM "meeting_files" f WHERE id = $1',
    id,
  );
  const [first] = rows;

  if (first === undefined) {
    throw new Error(`Expected a stored meeting file ${id}, found none`);
  }

  return first.row;
}

export async function countMeetingFiles(prisma: PrismaService): Promise<number> {
  // Postgres COUNT is int8; the driver may hand it back as a bigint or as a string.
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    'SELECT COUNT(*) AS count FROM "meeting_files"',
  );

  return Number(rows[0]?.count ?? 0);
}

export interface SeedMeetingFileRow {
  id?: string;
  meeting_id: string;
  uploader_id: string;
  name?: string;
  content_type?: string;
  size?: number;
  storage_key?: string;
  checksum?: string | null;
  thumbnail_key?: string | null;
  status?: string;
  failure_reason?: string | null;
  attempts?: number;
  leased_until?: Date | null;
  created_at?: Date;
  processed_at?: Date | null;
  deleted_at?: Date | null;
  purged_at?: Date | null;
}

/**
 * Inserts a row directly, for seeding caps and worker states the routes cannot produce on
 * demand. Returns the id. The storage key defaults to the layout the API uses; nothing here
 * writes an object to disk, so a seeded row points at bytes that do not exist unless the test
 * puts them there.
 */
export async function insertMeetingFileRow(
  prisma: PrismaService,
  row: SeedMeetingFileRow,
): Promise<string> {
  const id = row.id ?? randomUUID();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "meeting_files" (
       id, meeting_id, uploader_id, name, content_type, size, storage_key, checksum,
       thumbnail_key, status, failure_reason, attempts, leased_until, created_at,
       processed_at, deleted_at, purged_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::meeting_file_status, $11,
       $12, $13, $14, $15, $16, $17
     )`,
    id,
    row.meeting_id,
    row.uploader_id,
    row.name ?? 'seeded.txt',
    row.content_type ?? 'text/plain',
    row.size ?? 1,
    row.storage_key ?? `${row.meeting_id}/${id}`,
    row.checksum ?? null,
    row.thumbnail_key ?? null,
    row.status ?? 'uploaded',
    row.failure_reason ?? null,
    row.attempts ?? 0,
    row.leased_until ?? null,
    row.created_at ?? new Date(),
    row.processed_at ?? null,
    row.deleted_at ?? null,
    row.purged_at ?? null,
  );

  return id;
}

export interface MeetingFileState {
  status?: string;
  leased_until?: Date | null;
  attempts?: number;
  purged_at?: Date | null;
  thumbnail_key?: string | null;
}

/** Moves a row into a worker state a route cannot produce on demand. */
export async function setMeetingFileState(
  prisma: PrismaService,
  id: string,
  state: MeetingFileState,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  const set = (column: string, value: unknown, cast = ''): void => {
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}${cast}`);
  };

  if (state.status !== undefined) {
    set('status', state.status, '::meeting_file_status');
  }
  if (state.leased_until !== undefined) {
    set('leased_until', state.leased_until);
  }
  if (state.attempts !== undefined) {
    set('attempts', state.attempts);
  }
  if (state.purged_at !== undefined) {
    set('purged_at', state.purged_at);
  }
  if (state.thumbnail_key !== undefined) {
    set('thumbnail_key', state.thumbnail_key);
  }

  if (assignments.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "meeting_files" SET ${assignments.join(', ')} WHERE id = $1::uuid`,
    ...values,
  );
}
