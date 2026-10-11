-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "owner_id" UUID;

-- DropIndex
DROP INDEX "tasks_source_meeting_id_title_key";

-- CreateIndex
CREATE INDEX "tasks_owner_id_idx" ON "tasks"("owner_id");

-- CreateIndex
-- `NULLS NOT DISTINCT` added by hand: Prisma has no word for it. A task nobody owns has a
-- null here, and by default a null conflicts with nothing — so `TaskService.upsert` would
-- insert a second task of the same title every time, instead of updating the first.
-- PostgreSQL 15 and later.
CREATE UNIQUE INDEX "tasks_source_meeting_id_owner_id_title_key" ON "tasks"("source_meeting_id", "owner_id", "title") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
