import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * Reads and seeds the chunked upload sessions table over raw SQL rather than through
 * `prisma.meetingFileUpload`, for the reasons `meeting-files-table.ts` gives: the specs
 * compile before the model exists, and they assert the storage contract rather than the
 * client's view of it.
 *
 * The schema must map to **`meeting_file_uploads`** with **snake_case** columns:
 *
 * ```prisma
 * model MeetingFileUpload {
 *   id             String    @id @default(uuid())
 *   meetingId      String    @map("meeting_id")
 *   uploaderId     String    @map("uploader_id")
 *   name           String
 *   size           Int
 *   chunkSize      Int       @map("chunk_size")
 *   chunkCount     Int       @map("chunk_count")
 *   receivedChunks Int[]     @map("received_chunks")
 *   attempts       Int       @default(0)
 *   leasedUntil    DateTime? @map("leased_until")
 *   createdAt      DateTime  @default(now()) @map("created_at")
 *   expiresAt      DateTime  @map("expires_at")
 *   purgedAt       DateTime? @map("purged_at")
 *
 *   @@map("meeting_file_uploads")
 * }
 * ```
 *
 * No truncation helper, as with the other two tables: `truncateUsers` cascades here through
 * `meetings` and `users`.
 */
export interface MeetingFileUploadRow {
  id: string;
  meeting_id: string;
  uploader_id: string;
  name: string;
  size: number;
  chunk_size: number;
  chunk_count: number;
  received_chunks: number[];
  attempts: number;
  leased_until: string | null;
  created_at: string;
  expires_at: string;
  purged_at: string | null;
}

/** Every row, oldest first, as `to_jsonb` renders it — every column, so nothing is missed. */
export async function findMeetingFileUploadRows(
  prisma: PrismaService,
): Promise<MeetingFileUploadRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: MeetingFileUploadRow }>>(
    'SELECT to_jsonb(u) AS row FROM "meeting_file_uploads" u ORDER BY created_at, id',
  );

  return rows.map(({ row }) => row);
}

/** The single row for an id. Fails loudly rather than returning undefined. */
export async function findMeetingFileUploadRow(
  prisma: PrismaService,
  id: string,
): Promise<MeetingFileUploadRow> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: MeetingFileUploadRow }>>(
    'SELECT to_jsonb(u) AS row FROM "meeting_file_uploads" u WHERE id = $1',
    id,
  );
  const [first] = rows;

  if (first === undefined) {
    throw new Error(`Expected a stored upload session ${id}, found none`);
  }

  return first.row;
}

export async function countMeetingFileUploads(prisma: PrismaService): Promise<number> {
  // Postgres COUNT is int8; the driver may hand it back as a bigint or as a string.
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    'SELECT COUNT(*) AS count FROM "meeting_file_uploads"',
  );

  return Number(rows[0]?.count ?? 0);
}

export interface SeedMeetingFileUploadRow {
  id?: string;
  meeting_id: string;
  uploader_id: string;
  name?: string;
  size?: number;
  chunk_size?: number;
  chunk_count?: number;
  received_chunks?: number[];
  attempts?: number;
  leased_until?: Date | null;
  created_at?: Date;
  expires_at?: Date;
  purged_at?: Date | null;
}

/**
 * Inserts a session directly, for the states the routes cannot produce on demand — an expired
 * session, one already purged, one claimed too often. Returns the id. Nothing here writes a
 * chunk to disk, so a seeded session points at chunks that do not exist unless the test puts
 * them there.
 */
export async function insertMeetingFileUploadRow(
  prisma: PrismaService,
  row: SeedMeetingFileUploadRow,
): Promise<string> {
  const id = row.id ?? randomUUID();

  await prisma.$executeRawUnsafe(
    `INSERT INTO "meeting_file_uploads" (
       id, meeting_id, uploader_id, name, size, chunk_size, chunk_count, received_chunks,
       attempts, leased_until, created_at, expires_at, purged_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::int[], $9, $10, $11, $12, $13
     )`,
    id,
    row.meeting_id,
    row.uploader_id,
    row.name ?? 'seeded.bin',
    row.size ?? 1,
    row.chunk_size ?? 1,
    row.chunk_count ?? 1,
    row.received_chunks ?? [],
    row.attempts ?? 0,
    row.leased_until ?? null,
    row.created_at ?? new Date(),
    row.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1_000),
    row.purged_at ?? null,
  );

  return id;
}

export interface MeetingFileUploadState {
  received_chunks?: number[];
  attempts?: number;
  leased_until?: Date | null;
  expires_at?: Date;
  purged_at?: Date | null;
}

/** Moves a session into a state a route cannot produce on demand — expiry, above all. */
export async function setMeetingFileUploadState(
  prisma: PrismaService,
  id: string,
  state: MeetingFileUploadState,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  const set = (column: string, value: unknown, cast = ''): void => {
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}${cast}`);
  };

  if (state.received_chunks !== undefined) {
    set('received_chunks', state.received_chunks, '::int[]');
  }
  if (state.attempts !== undefined) {
    set('attempts', state.attempts);
  }
  if (state.leased_until !== undefined) {
    set('leased_until', state.leased_until);
  }
  if (state.expires_at !== undefined) {
    set('expires_at', state.expires_at);
  }
  if (state.purged_at !== undefined) {
    set('purged_at', state.purged_at);
  }

  if (assignments.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "meeting_file_uploads" SET ${assignments.join(', ')} WHERE id = $1::uuid`,
    ...values,
  );
}
