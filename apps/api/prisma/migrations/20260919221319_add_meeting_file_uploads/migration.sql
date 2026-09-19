-- CreateTable
CREATE TABLE "meeting_file_uploads" (
    "id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "chunk_size" INTEGER NOT NULL,
    "chunk_count" INTEGER NOT NULL,
    "received_chunks" INTEGER[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leased_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "meeting_file_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_file_uploads_meeting_id_idx" ON "meeting_file_uploads"("meeting_id");

-- CreateIndex
CREATE INDEX "meeting_file_uploads_expires_at_purged_at_idx" ON "meeting_file_uploads"("expires_at", "purged_at");

-- AddForeignKey
ALTER TABLE "meeting_file_uploads" ADD CONSTRAINT "meeting_file_uploads_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_file_uploads" ADD CONSTRAINT "meeting_file_uploads_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
