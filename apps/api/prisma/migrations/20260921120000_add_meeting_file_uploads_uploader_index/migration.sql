-- CreateIndex
CREATE INDEX "meeting_file_uploads_uploader_id_purged_at_idx" ON "meeting_file_uploads"("uploader_id", "purged_at");
