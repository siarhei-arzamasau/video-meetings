import { PrismaService } from '../../src/modules/prisma/prisma.service';

/**
 * The stored transcription vocabulary, restated rather than imported for the reason
 * `fixtures.ts` restates everything else: a spec that spelt a status out of the application's
 * own constant would keep passing the day the stored value changed.
 */
export const QUEUED = 'QUEUED';
export const TRANSCRIBING = 'TRANSCRIBING';
export const TRANSCRIBED = 'TRANSCRIBED';
export const FAILED = 'FAILED';

export interface MeetingFileTranscriptionState {
  transcription_status?: string | null;
  transcription_failure_reason?: string | null;
  transcription_attempts?: number;
  transcription_leased_until?: Date | null;
}

/**
 * Moves a row's transcription into a state no route can produce on demand: a claim whose
 * worker died (`TRANSCRIBING` with a lease in the past), a claim count at the cap, a status on
 * a row seeded directly. Raw SQL, like every other table helper, so the column names and the
 * enum's name are pinned by the specs that use it.
 */
export async function setMeetingFileTranscriptionState(
  prisma: PrismaService,
  id: string,
  state: MeetingFileTranscriptionState,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [id];

  const set = (column: string, value: unknown, cast = ''): void => {
    values.push(value);
    assignments.push(`${column} = $${String(values.length)}${cast}`);
  };

  if (state.transcription_status !== undefined) {
    set('transcription_status', state.transcription_status, '::meeting_file_transcription_status');
  }
  if (state.transcription_failure_reason !== undefined) {
    set('transcription_failure_reason', state.transcription_failure_reason);
  }
  if (state.transcription_attempts !== undefined) {
    set('transcription_attempts', state.transcription_attempts);
  }
  if (state.transcription_leased_until !== undefined) {
    set('transcription_leased_until', state.transcription_leased_until);
  }

  if (assignments.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `UPDATE "meeting_files" SET ${assignments.join(', ')} WHERE id = $1::uuid`,
    ...values,
  );
}
