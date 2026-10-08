import { Test } from '@nestjs/testing';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { FindMeetingTranscriptsQuery } from '../find-meeting-transcripts.query';
import { FindMeetingTranscriptsHandler } from './find-meeting-transcripts.handler';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const LIMIT = 100;

const recording = (id: string): { id: string; uploaderId: string; transcriptKey: string } => ({
  id,
  uploaderId: 'ada',
  transcriptKey: `${MEETING_ID}/${id}.transcript.txt`,
});

describe('FindMeetingTranscriptsHandler', () => {
  const findTranscribedOf = jest.fn();
  const stat = jest.fn();
  const readText = jest.fn();
  /** What is stored under each key; `stat` and `readText` both answer from it. */
  let stored: Record<string, string>;
  let handler: FindMeetingTranscriptsHandler;

  const store = (texts: Record<string, string>): void => {
    stored = Object.fromEntries(
      Object.entries(texts).map(([id, text]) => [recording(id).transcriptKey, text]),
    );
    findTranscribedOf.mockResolvedValue(Object.keys(texts).map(recording));
  };

  const ask = (maxCharacters = LIMIT): ReturnType<FindMeetingTranscriptsHandler['execute']> =>
    handler.execute(new FindMeetingTranscriptsQuery(MEETING_ID, maxCharacters));

  beforeEach(async () => {
    stored = {};
    findTranscribedOf.mockReset().mockResolvedValue([]);
    stat.mockReset().mockImplementation(async (key: string) => {
      const text = stored[key];

      if (text === undefined) {
        throw new Error(`ENOENT: ${key}`);
      }

      return { size: Buffer.byteLength(text, 'utf8') };
    });
    readText.mockReset().mockImplementation(async (key: string) => stored[key]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindMeetingTranscriptsHandler,
        { provide: MeetingFileTranscriptionRepository, useValue: { findTranscribedOf } },
        { provide: MeetingFileStorage, useValue: { stat, readText } },
      ],
    }).compile();

    handler = moduleRef.get(FindMeetingTranscriptsHandler);
  });

  it('answers every transcript whole, under its file id, in upload order', async () => {
    store({ first: 'We ship on Friday.', second: 'Grace sends the notes.' });

    await expect(ask()).resolves.toEqual({
      withinLimit: true,
      transcripts: [
        { fileId: 'first', text: 'We ship on Friday.' },
        { fileId: 'second', text: 'Grace sends the notes.' },
      ],
    });
    expect(findTranscribedOf).toHaveBeenCalledWith(MEETING_ID);
  });

  it('answers no transcripts, within the limit, for a meeting with nothing transcribed', async () => {
    await expect(ask()).resolves.toEqual({ withinLimit: true, transcripts: [] });
  });

  it('keeps a blank transcript: a recording in which nothing was heard is still a recording', async () => {
    store({ silent: '', spoken: 'Hello.' });

    await expect(ask()).resolves.toEqual({
      withinLimit: true,
      transcripts: [
        { fileId: 'silent', text: '' },
        { fileId: 'spoken', text: 'Hello.' },
      ],
    });
  });

  it('accepts transcripts that are exactly the limit together', async () => {
    store({ first: 'a'.repeat(60), second: 'b'.repeat(40) });

    await expect(ask()).resolves.toMatchObject({ withinLimit: true });
  });

  it('answers that they are past the limit, with none of the text, one character over', async () => {
    store({ first: 'a'.repeat(60), second: 'b'.repeat(41) });

    await expect(ask()).resolves.toEqual({ withinLimit: false });
  });

  it('stops reading at the limit: recordings after the one that passed it are never opened', async () => {
    store({ first: 'a'.repeat(60), second: 'b'.repeat(41), third: 'c', fourth: 'd' });

    await ask();

    expect(readText.mock.calls.map(([key]: [string]) => key)).toEqual([
      recording('first').transcriptKey,
      recording('second').transcriptKey,
    ]);
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('does not load a file that cannot fit, judging by its size on disk alone', async () => {
    // 301 bytes cannot be 100 characters or fewer: UTF-8 never spends more than three bytes
    // on what a string counts as one.
    store({ huge: 'a'.repeat(301) });

    await expect(ask()).resolves.toEqual({ withinLimit: false });
    expect(readText).not.toHaveBeenCalled();
  });

  it('counts characters, not bytes: text of three bytes a character is read up to the limit', async () => {
    // 100 characters and 300 bytes — the size check must let it through to be counted.
    store({ japanese: '会'.repeat(100) });

    await expect(ask()).resolves.toMatchObject({ withinLimit: true });
  });

  it('rejects when a transcript cannot be read, rather than answer without it', async () => {
    store({ first: 'We ship on Friday.' });
    findTranscribedOf.mockResolvedValue([recording('first'), recording('purged')]);

    await expect(ask()).rejects.toThrow(/ENOENT/);
  });
});
