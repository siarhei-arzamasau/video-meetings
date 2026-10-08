import { Test } from '@nestjs/testing';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { FindTranscribedRecordingsQuery } from '../find-transcribed-recordings.query';
import { FindTranscribedRecordingsHandler } from './find-transcribed-recordings.handler';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

describe('FindTranscribedRecordingsHandler', () => {
  const findTranscribedOf = jest.fn();
  let handler: FindTranscribedRecordingsHandler;

  beforeEach(async () => {
    findTranscribedOf.mockReset().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindTranscribedRecordingsHandler,
        { provide: MeetingFileTranscriptionRepository, useValue: { findTranscribedOf } },
      ],
    }).compile();

    handler = moduleRef.get(FindTranscribedRecordingsHandler);
  });

  it("answers with each recording's id and uploader, in the order they were read", async () => {
    findTranscribedOf.mockResolvedValue([
      { id: 'first', uploaderId: 'ada', transcriptKey: 'm/first.transcript.txt' },
      { id: 'second', uploaderId: 'grace', transcriptKey: 'm/second.transcript.txt' },
    ]);

    const recordings = await handler.execute(new FindTranscribedRecordingsQuery(MEETING_ID));

    expect(findTranscribedOf).toHaveBeenCalledWith(MEETING_ID);
    // Exactly these two fields: a storage key is a path, and does not cross the boundary.
    expect(recordings).toEqual([
      { id: 'first', uploaderId: 'ada' },
      { id: 'second', uploaderId: 'grace' },
    ]);
  });

  it('answers an empty list, never null, for a meeting with nothing transcribed', async () => {
    await expect(handler.execute(new FindTranscribedRecordingsQuery(MEETING_ID))).resolves.toEqual(
      [],
    );
  });
});
