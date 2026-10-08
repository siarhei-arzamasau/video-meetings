-- CreateEnum
CREATE TYPE "meeting_digest_status" AS ENUM ('QUEUED', 'GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "meeting_digests" (
    "id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "status" "meeting_digest_status",
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leased_until" TIMESTAMPTZ(3),
    "requested_revision" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "generated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_digest_action_items" (
    "id" UUID NOT NULL,
    "digest_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "owner_name" TEXT,
    "owner_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_digest_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_digest_decisions" (
    "id" UUID NOT NULL,
    "digest_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_digest_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_digest_sources" (
    "id" UUID NOT NULL,
    "digest_id" UUID NOT NULL,
    "meeting_file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_digest_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_digests_meeting_id_key" ON "meeting_digests"("meeting_id");

-- CreateIndex
CREATE INDEX "meeting_digests_meeting_id_idx" ON "meeting_digests"("meeting_id");

-- CreateIndex
CREATE INDEX "meeting_digests_status_leased_until_idx" ON "meeting_digests"("status", "leased_until");

-- CreateIndex
CREATE INDEX "meeting_digest_action_items_digest_id_idx" ON "meeting_digest_action_items"("digest_id");

-- CreateIndex
CREATE INDEX "meeting_digest_action_items_owner_id_idx" ON "meeting_digest_action_items"("owner_id");

-- CreateIndex
CREATE INDEX "meeting_digest_decisions_digest_id_idx" ON "meeting_digest_decisions"("digest_id");

-- CreateIndex
CREATE INDEX "meeting_digest_sources_digest_id_idx" ON "meeting_digest_sources"("digest_id");

-- CreateIndex
CREATE INDEX "meeting_digest_sources_meeting_file_id_idx" ON "meeting_digest_sources"("meeting_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_digest_sources_digest_id_meeting_file_id_key" ON "meeting_digest_sources"("digest_id", "meeting_file_id");

-- AddForeignKey
ALTER TABLE "meeting_digests" ADD CONSTRAINT "meeting_digests_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_digest_action_items" ADD CONSTRAINT "meeting_digest_action_items_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "meeting_digests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_digest_action_items" ADD CONSTRAINT "meeting_digest_action_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_digest_decisions" ADD CONSTRAINT "meeting_digest_decisions_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "meeting_digests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_digest_sources" ADD CONSTRAINT "meeting_digest_sources_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "meeting_digests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_digest_sources" ADD CONSTRAINT "meeting_digest_sources_meeting_file_id_fkey" FOREIGN KEY ("meeting_file_id") REFERENCES "meeting_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
