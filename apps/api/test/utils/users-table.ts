import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * Reads and clears the users table over raw SQL rather than through `prisma.user`.
 *
 * Two reasons, both deliberate:
 *
 * 1. **The specs compile before the model exists.** Nothing here depends on generated
 *    Prisma types, so the e2e suite can be written and run first — it fails on a missing
 *    route or a missing table, which is the failure TDD wants, not a TypeScript error.
 * 2. **It asserts the storage contract, not the client's view of it.** Going through the
 *    generated client would pass against any column layout Prisma happens to map.
 *
 * The trade-off is that these names are now part of what the tests pin down. The schema
 * must map to a **`users`** table with **snake_case** columns:
 *
 * ```prisma
 * model User {
 *   id           String   @id @default(uuid())
 *   email        String   @unique
 *   passwordHash String   @map("password_hash")
 *   displayName  String   @map("display_name")
 *   createdAt    DateTime @default(now()) @map("created_at")
 *
 *   @@map("users")
 * }
 * ```
 *
 * Change that mapping and these helpers must change with it.
 */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
}

const SELECT_COLUMNS = 'id, email, password_hash, display_name, created_at';

/**
 * Empties users and every table with a foreign key to it, so each test starts from a known
 * state. PostgreSQL's `TRUNCATE ... CASCADE` follows referencing foreign keys regardless of
 * their `ON DELETE` action; this deliberately covers meeting and participant tables without
 * coupling the shared test lifecycle to current or future feature-table names.
 */
export async function truncateUsers(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
}

/**
 * Every row for an email — an array, not a single row, so "exactly one user exists" is
 * something a test can assert instead of assume.
 */
export async function findUserRows(prisma: PrismaService, email: string): Promise<UserRow[]> {
  return prisma.$queryRawUnsafe<UserRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM "users" WHERE email = $1`,
    email,
  );
}

/** The single row for an email. Fails loudly rather than returning undefined. */
export async function findUserRow(prisma: PrismaService, email: string): Promise<UserRow> {
  const rows = await findUserRows(prisma, email);
  const [row] = rows;

  if (row === undefined) {
    throw new Error(`Expected a stored user for ${email}, found none`);
  }

  if (rows.length > 1) {
    throw new Error(`Expected one stored user for ${email}, found ${String(rows.length)}`);
  }

  return row;
}

/**
 * The whole row as JSON, every column included.
 *
 * `findUserRow` names its columns, so it cannot notice a column it does not select — a
 * "nothing changed" assertion built on it would still pass after the implementation starts
 * writing, say, `last_login_at`. This sees every column, including ones added later.
 */
export async function readUserSnapshot(
  prisma: PrismaService,
  email: string,
): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
    'SELECT to_jsonb(u) AS row FROM "users" u WHERE email = $1',
    email,
  );
  const [first] = rows;

  if (first === undefined) {
    throw new Error(`Expected a stored user for ${email}, found none`);
  }

  return first.row;
}

/** Removes one user, for the case of a token whose subject no longer exists. */
export async function deleteUser(prisma: PrismaService, email: string): Promise<void> {
  await prisma.$executeRawUnsafe('DELETE FROM "users" WHERE email = $1', email);
}

export async function countUsers(prisma: PrismaService): Promise<number> {
  // Postgres COUNT is int8; the driver may hand it back as a bigint or as a string.
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | string }>>(
    'SELECT COUNT(*) AS count FROM "users"',
  );

  return Number(rows[0]?.count ?? 0);
}
