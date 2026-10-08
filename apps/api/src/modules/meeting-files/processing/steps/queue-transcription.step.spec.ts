import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MEETING_FILE_ALLOWED_TYPES } from '@repo/shared';

import { TranscriptionStatus } from '../../services/meeting-file-transcription-status';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import type { MeetingFileStorage } from '../../storage/meeting-file-storage';
import type { StepContext } from '../step';
import { QueueTranscriptionStep } from './queue-transcription.step';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

/** The six recording types the upload accepts, by the type each is stored under. */
const RECORDINGS = [
  ['MP3', 'audio/mpeg'],
  ['M4A', 'audio/mp4'],
  ['WAV', 'audio/wav'],
  ['MP4', 'video/mp4'],
  // An `.m4v` is stored as `video/mp4`: the sniffer maps its brand onto the allow-list's name.
  ['M4V', 'video/mp4'],
  ['WebM', 'video/webm'],
] as const;

const QUEUED = { transcriptionStatus: TranscriptionStatus.QUEUED };

const step = (values: Record<string, unknown>): QueueTranscriptionStep =>
  new QueueTranscriptionStep({
    get: (key: string, fallback: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService);

describe('QueueTranscriptionStep', () => {
  const record = (contentType: string): MeetingFileRecord =>
    buildMeetingFileRecord({
      id: FILE_ID,
      meetingId: MEETING_ID,
      name: 'standup',
      contentType,
      size: 12,
      status: 'processing',
      attempts: 1,
    });

  /**
   * A storage that fails the test if it is touched: queueing is a decision about a row, and a
   * step that opened the object would be transcribing inside the file's own pipeline again.
   */
  const untouchable = new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`The queueing step touched storage.${String(property)}`);
      },
    },
  ) as MeetingFileStorage;

  const context = (contentType: string): StepContext => ({
    record: record(contentType),
    storage: untouchable,
    logger: new Logger('test'),
    signal: new AbortController().signal,
  });

  const on = step({ MEETING_FILES_TRANSCRIPTION_ENABLED: true });
  const off = step({ MEETING_FILES_TRANSCRIPTION_ENABLED: false });

  it('is the last word on a file, under a name the worker can log', () => {
    expect(on.name).toBe('queue-transcription');
  });

  it.each(RECORDINGS)('queues an %s (%s) while the setting is on', async (_label, contentType) => {
    await expect(on.run(context(contentType))).resolves.toEqual(QUEUED);
  });

  it.each([
    ['a PDF', 'application/pdf'],
    ['a PNG', 'image/png'],
  ])('queues nothing for %s', async (_label, contentType) => {
    await expect(on.run(context(contentType))).resolves.toEqual({});
  });

  it('decides every accepted type the same way: audio and video, and nothing else', async () => {
    const patches = await Promise.all(
      MEETING_FILE_ALLOWED_TYPES.map(async (contentType) => ({
        contentType,
        queued: 'transcriptionStatus' in (await on.run(context(contentType))),
      })),
    );

    expect(patches.filter(({ queued }) => queued).map(({ contentType }) => contentType)).toEqual(
      MEETING_FILE_ALLOWED_TYPES.filter((type) => /^(audio|video)\//.test(type)),
    );
    // And the six recordings are all of them: no accepted audio or video type is left out.
    expect(new Set(RECORDINGS.map(([, type]) => type))).toEqual(
      new Set(patches.filter(({ queued }) => queued).map(({ contentType }) => contentType)),
    );
  });

  it.each([...RECORDINGS, ['PDF', 'application/pdf'], ['PNG', 'image/png']] as const)(
    'queues nothing for an %s (%s) while the setting is off',
    async (_label, contentType) => {
      await expect(off.run(context(contentType))).resolves.toEqual({});
    },
  );

  it('is off unless the setting says otherwise', async () => {
    await expect(step({}).run(context('audio/mpeg'))).resolves.toEqual({});
  });

  it('asks for the setting on every run, so it can change without rebuilding the step', async () => {
    const values: Record<string, unknown> = { MEETING_FILES_TRANSCRIPTION_ENABLED: false };
    const flipped = step(values);

    await expect(flipped.run(context('audio/mpeg'))).resolves.toEqual({});
    values['MEETING_FILES_TRANSCRIPTION_ENABLED'] = true;
    await expect(flipped.run(context('audio/mpeg'))).resolves.toEqual(QUEUED);
  });
});
