import fs from 'node:fs';
import path from 'node:path';

import type { MeetingFileUpload } from '@repo/shared';

import { useApiSuite } from './utils/api-suite';
import {
  EMAIL,
  MEETING_FILE_CHUNK_SIZE_BYTES,
  OTHER_EMAIL,
  meetingFileChunkUrl,
  meetingFileUploadsUrl,
  meetingFilesDir,
} from './utils/fixtures';
import { createMeeting, putHeadersOnly, registerUser } from './utils/meeting-files-suite';

const CHUNK = MEETING_FILE_CHUNK_SIZE_BYTES;

/** A well-formed id no session has. */
const UNKNOWN_UPLOAD_ID = '99999999-9999-4999-8999-999999999999';

const storedChunks = (uploadId: string): string[] => {
  const dir = path.join(meetingFilesDir(), 'uploads', uploadId);

  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

/**
 * What a member of the meeting is answered before a chunk's body is read.
 *
 * `meeting-file-uploads.e2e-spec.ts` pins the same for a caller with no token and for a
 * stranger to the meeting. Those two left one caller out: a member — which, for a meeting of
 * one's own, is any account — naming a session that is not theirs or a chunk the session does
 * not have. The parser used to run before either was asked about, so each such request held a
 * whole chunk of memory for as long as its body took to arrive.
 *
 * Every request here declares a chunk and never sends it, so an answer is one the server gave
 * from the headers alone: a server that reads first is still waiting.
 */
describe('a chunk the session does not expect is refused before its body is read', () => {
  const suite = useApiSuite();

  const openSession = async (): Promise<{
    host: { id: string; token: string };
    other: { id: string; token: string };
    meetingId: string;
    uploadId: string;
  }> => {
    const host = await registerUser(suite, EMAIL);
    const other = await registerUser(suite, OTHER_EMAIL);
    const meeting = await createMeeting(suite, host, [other.id]);
    // Two chunks: a whole one, then one byte.
    const created = await suite
      .post(meetingFileUploadsUrl(meeting.id), { name: 'recording.mp4', size: CHUNK + 1 })
      .set('Authorization', `Bearer ${host.token}`)
      .expect(201);

    return { host, other, meetingId: meeting.id, uploadId: (created.body as MeetingFileUpload).id };
  };

  const declareChunk = (token: string, meetingId: string, uploadId: string, index: number) =>
    putHeadersOnly(
      suite,
      meetingFileChunkUrl(meetingId, uploadId, index),
      { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      CHUNK,
    );

  it('404 Upload not found for a session id nobody opened', async () => {
    const { host, meetingId } = await openSession();

    const answer = await declareChunk(host.token, meetingId, UNKNOWN_UPLOAD_ID, 0);

    expect(answer).toMatchObject({ status: 404, body: { message: 'Upload not found' } });
    expect(storedChunks(UNKNOWN_UPLOAD_ID)).toEqual([]);
  });

  it('404 Upload not found for another member’s session', async () => {
    const { other, meetingId, uploadId } = await openSession();

    const answer = await declareChunk(other.token, meetingId, uploadId, 0);

    expect(answer).toMatchObject({ status: 404, body: { message: 'Upload not found' } });
    expect(storedChunks(uploadId)).toEqual([]);
  });

  it('400 Chunk index out of range for a chunk past the end of the plan', async () => {
    const { host, meetingId, uploadId } = await openSession();

    const answer = await declareChunk(host.token, meetingId, uploadId, 2);

    expect(answer).toMatchObject({ status: 400, body: { message: 'Chunk index out of range' } });
    expect(storedChunks(uploadId)).toEqual([]);
  });
});
