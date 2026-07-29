import 'dotenv/config';

import { defineConfig } from 'prisma/config';

// Consumed by the Prisma CLI (generate, migrate, studio). The running application does
// not read this file — PrismaService supplies the connection through a driver adapter.
//
// The fallback matches docker-compose and .env.example so `prisma generate` works on a
// clean clone. Commands that actually reach the database still need a real DATABASE_URL.
const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5433/video_meetings';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
});
