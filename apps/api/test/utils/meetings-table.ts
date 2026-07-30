import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * Reads the meetings tables over raw SQL rather than through `prisma.meeting`, for the same
 * two reasons `users-table.ts` does:
 *
 * 1. **Nothing here depends on generated Prisma types**, so a spec fails on a missing table
 *    rather than on a TypeScript error against a stale client.
 * 2. **It asserts the storage contract, not the client's view of it.** Going through the
 *    generated client would pass against any column layout Prisma happens to map, and would
 *    apply the same `include` the implementation uses — so a test could not notice the
 *    implementation writing a row it never meant to.
 *
 * The trade-off is that these names are part of what the specs pin down. The schema must map
 * to **`meetings`** and **`meeting_participants`** with **snake_case** columns:
 *
 * ```prisma
 * model Meeting {
 *   id          String        @id @default(uuid())
 *   title       String
 *   status      MeetingStatus @default(scheduled)
 *   hostId      String        @map("host_id")
 *   scheduledAt DateTime      @map("scheduled_at")
 *
 *   @@map("meetings")
 * }
 *
 * model MeetingParticipant {
 *   meetingId String @map("meeting_id")
 *   userId    String @map("user_id")
 *
 *   @@id([meetingId, userId])
 *   @@map("meeting_participants")
 * }
 * ```
 *
 * There is no truncation helper here on purpose: `truncateUsers` cascades to both tables, and
 * a second one would be a way for the two to disagree about what "clean" means.
 */
export interface MeetingRow {
  id: string;
  title: string;
  status: string;
  host_id: string;
  scheduled_at: Date;
}

/** Every meeting row, oldest scheduled first. An array, so "exactly one" is assertable. */
export async function findMeetingRows(prisma: PrismaService): Promise<MeetingRow[]> {
  return prisma.$queryRawUnsafe<MeetingRow[]>(
    'SELECT id, title, status, host_id, scheduled_at FROM "meetings" ORDER BY scheduled_at, id',
  );
}

/**
 * The participant ids stored for a meeting, in the database's own order.
 *
 * Read separately from the meeting rather than joined, so a spec can tell "the host was
 * written into the participants table" apart from "the response listed the host".
 */
export async function findParticipantIds(
  prisma: PrismaService,
  meetingId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ user_id: string }>>(
    'SELECT user_id FROM "meeting_participants" WHERE meeting_id = $1 ORDER BY user_id',
    meetingId,
  );

  return rows.map(({ user_id }) => user_id);
}

export async function countMeetings(prisma: PrismaService): Promise<number> {
  // Postgres COUNT is int8; the driver may hand it back as a bigint or as a string.
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    'SELECT COUNT(*) AS count FROM "meetings"',
  );

  return Number(rows[0]?.count ?? 0);
}

export async function countParticipants(prisma: PrismaService): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    'SELECT COUNT(*) AS count FROM "meeting_participants"',
  );

  return Number(rows[0]?.count ?? 0);
}
