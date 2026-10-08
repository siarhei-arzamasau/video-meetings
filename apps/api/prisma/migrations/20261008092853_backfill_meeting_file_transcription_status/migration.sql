-- Recordings the pipeline's old transcription step handled already have their transcript on
-- disk and its key on the row, but no status: that column did not exist when they were
-- transcribed. The page offers "Open transcript" only for a transcribed recording, so without
-- this they keep a transcript nobody is shown.
--
-- Only a file that is still `ready`: a deleted row's transcript is gone, or about to be.
UPDATE "meeting_files"
SET "transcription_status" = 'TRANSCRIBED'
WHERE "transcript_key" IS NOT NULL
  AND "transcription_status" IS NULL
  AND "status" = 'ready';
