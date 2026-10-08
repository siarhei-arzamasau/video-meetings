-- CreateEnum
CREATE TYPE "meeting_file_transcription_status" AS ENUM ('QUEUED', 'TRANSCRIBING', 'TRANSCRIBED', 'FAILED');

-- AlterTable
ALTER TABLE "meeting_files" ADD COLUMN     "transcription_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transcription_failure_reason" TEXT,
ADD COLUMN     "transcription_leased_until" TIMESTAMPTZ(3),
ADD COLUMN     "transcription_status" "meeting_file_transcription_status";

-- CreateIndex
CREATE INDEX "meeting_files_transcription_status_transcription_leased_unt_idx" ON "meeting_files"("transcription_status", "transcription_leased_until");
