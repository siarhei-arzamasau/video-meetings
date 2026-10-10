import { Test } from '@nestjs/testing';

import { MeetingFileTranscriptionRepository } from '../../services/meeting-file-transcription.repository';
import { FindTranscribedRecordingsByMeetingHandler } from './find-transcribed-recordings-by-meeting.handler';

const LAUNCH_MEETING_ID = '44444444-4444-4444-8444-444444444444';
const PRICING_MEETING_ID = '66666666-6666-4666-8666-666666666666';

describe('FindTranscribedRecordingsByMeetingHandler', () => {
  const findAllTranscribed = jest.fn();
  let handler: FindTranscribedRecordingsByMeetingHandler;

  beforeEach(async () => {
    findAllTranscribed.mockReset().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        FindTranscribedRecordingsByMeetingHandler,
        { provide: MeetingFileTranscriptionRepository, useValue: { findAllTranscribed } },
      ],
    }).compile();

    handler = moduleRef.get(FindTranscribedRecordingsByMeetingHandler);
  });

  it('gathers the recordings of each meeting, keeping the order they were read in', async () => {
    findAllTranscribed.mockResolvedValue([
      { id: 'launch-first', meetingId: LAUNCH_MEETING_ID },
      { id: 'pricing-only', meetingId: PRICING_MEETING_ID },
      { id: 'launch-second', meetingId: LAUNCH_MEETING_ID },
    ]);

    // Exactly a meeting's id and its files': no uploader, and no storage key.
    await expect(handler.execute()).resolves.toEqual([
      { meetingId: LAUNCH_MEETING_ID, fileIds: ['launch-first', 'launch-second'] },
      { meetingId: PRICING_MEETING_ID, fileIds: ['pricing-only'] },
    ]);
  });

  it('answers an empty list when no meeting has a transcribed recording', async () => {
    await expect(handler.execute()).resolves.toEqual([]);
  });
});
