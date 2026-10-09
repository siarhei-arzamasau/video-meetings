-- Added by hand: Prisma does not manage extensions here, and the trigram index below, with
-- the `%` and `<%` operators `TaskService.search` uses, exists only once this one does.
-- Trusted since PostgreSQL 13, so the database's owner can create it without a superuser.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('OPEN', 'DONE');

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source_meeting_id" UUID NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_source_meeting_id_idx" ON "tasks"("source_meeting_id");

-- CreateIndex
CREATE INDEX "tasks_title_idx" ON "tasks" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "tasks_source_meeting_id_title_key" ON "tasks"("source_meeting_id", "title");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_meeting_id_fkey" FOREIGN KEY ("source_meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
