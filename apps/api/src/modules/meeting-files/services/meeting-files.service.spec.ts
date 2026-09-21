import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
import { MeetingFileStorage } from '../storage/meeting-file-storage';
import { MeetingFileRepository } from './meeting-file.repository';
import type { MeetingFileRecord } from './meeting-file.mapper';
import { MeetingFilesService } from './meeting-files.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';

const MEETING = {
  id: MEETING_ID,
  title: 'Engine review',
  status: 'scheduled',
  hostId: USER_ID,
  scheduledAt: '2026-08-01T10:00:00.000Z',
  participantIds: [],
};

const RECORD: MeetingFileRecord = {
  id: FILE_ID,
  meetingId: MEETING_ID,
  uploaderId: USER_ID,
  name: 'deck.pdf',
  contentType: 'application/pdf',
  size: 10,
  storageKey: `${MEETING_ID}/${FILE_ID}`,
  checksum: null,
  thumbnailKey: null,
  transcriptKey: null,
  status: 'uploaded',
  failureReason: null,
  attempts: 0,
  leasedUntil: null,
  createdAt: new Date('2026-09-01T10:00:00.000Z'),
  processedAt: null,
  deletedAt: null,
  purgedAt: null,
};

describe('MeetingFilesService', () => {
  const execute = jest.fn();
  const findAllOf = jest.fn();
  const findOneOf = jest.fn();
  const stat = jest.fn();
  const openRead = jest.fn();
  const STREAM = { fake: 'stream' };
  let service: MeetingFilesService;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findAllOf.mockReset().mockResolvedValue([RECORD]);
    findOneOf.mockReset().mockResolvedValue(RECORD);
    stat.mockReset().mockResolvedValue({ size: 10 });
    openRead.mockReset().mockReturnValue(STREAM);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFilesService,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findAllOf, findOneOf } },
        { provide: MeetingFileStorage, useValue: { stat, openRead } },
      ],
    }).compile();

    service = moduleRef.get(MeetingFilesService);
  });

  describe('findAll', () => {
    it('resolves the meeting through the bus before reading files', async () => {
      await service.findAll(USER_ID, MEETING_ID);

      expect(execute).toHaveBeenCalledWith(new FindVisibleMeetingQuery(USER_ID, MEETING_ID));
      expect(findAllOf).toHaveBeenCalledWith(MEETING_ID);
    });

    it('answers 404 Meeting not found for an invisible meeting, without touching files', async () => {
      execute.mockResolvedValue(null);

      await expect(service.findAll(USER_ID, MEETING_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
      expect(findAllOf).not.toHaveBeenCalled();
    });

    it('maps every record to the wire shape', async () => {
      await expect(service.findAll(USER_ID, MEETING_ID)).resolves.toEqual([
        {
          id: FILE_ID,
          meetingId: MEETING_ID,
          uploaderId: USER_ID,
          name: 'deck.pdf',
          contentType: 'application/pdf',
          size: 10,
          status: 'uploaded',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ]);
    });
  });

  describe('findOne', () => {
    it('scopes the lookup to the meeting', async () => {
      await service.findOne(USER_ID, MEETING_ID, FILE_ID);

      expect(findOneOf).toHaveBeenCalledWith(MEETING_ID, FILE_ID);
    });

    it('answers 404 File not found on a miss', async () => {
      findOneOf.mockResolvedValue(null);

      await expect(service.findOne(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('File not found'),
      );
    });

    it('answers 404 Meeting not found before the file lookup for an invisible meeting', async () => {
      execute.mockResolvedValue(null);

      await expect(service.findOne(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
      expect(findOneOf).not.toHaveBeenCalled();
    });
  });

  describe('openContent', () => {
    it("opens the object under the record's storage key with the record's size and type", async () => {
      await expect(service.openContent(USER_ID, MEETING_ID, FILE_ID)).resolves.toEqual({
        name: 'deck.pdf',
        contentType: 'application/pdf',
        size: 10,
        stream: STREAM,
      });

      expect(openRead).toHaveBeenCalledWith(RECORD.storageKey);
    });

    it('serves a failed file — failing to process is not losing it', async () => {
      findOneOf.mockResolvedValue({ ...RECORD, status: 'failed', failureReason: 'x' });

      await expect(service.openContent(USER_ID, MEETING_ID, FILE_ID)).resolves.toMatchObject({
        stream: STREAM,
      });
    });

    it('answers a 500 with an error body when the object is missing, before any stream opens', async () => {
      stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expect(service.openContent(USER_ID, MEETING_ID, FILE_ID)).rejects.toMatchObject({
        status: 500,
        message: 'The stored file is missing',
      });
      expect(openRead).not.toHaveBeenCalled();
    });

    it('answers 404 for an invisible meeting without touching storage', async () => {
      execute.mockResolvedValue(null);

      await expect(service.openContent(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
      expect(stat).not.toHaveBeenCalled();
    });
  });

  describe('openThumbnail', () => {
    it('answers 404 Thumbnail not found when the record has no thumbnail key', async () => {
      await expect(service.openThumbnail(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('Thumbnail not found'),
      );
      expect(stat).not.toHaveBeenCalled();
    });

    it('opens the thumbnail as WebP with its own size', async () => {
      const thumbnailKey = `${RECORD.storageKey}.thumb.webp`;
      findOneOf.mockResolvedValue({ ...RECORD, thumbnailKey });
      stat.mockResolvedValue({ size: 3 });

      await expect(service.openThumbnail(USER_ID, MEETING_ID, FILE_ID)).resolves.toEqual({
        name: 'deck.pdf.thumb.webp',
        contentType: 'image/webp',
        size: 3,
        stream: STREAM,
      });

      expect(stat).toHaveBeenCalledWith(thumbnailKey);
      expect(openRead).toHaveBeenCalledWith(thumbnailKey);
    });
  });

  describe('openTranscript', () => {
    it('answers 404 Transcript not found when the record has no transcript key', async () => {
      await expect(service.openTranscript(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('Transcript not found'),
      );
      expect(stat).not.toHaveBeenCalled();
    });

    it('opens the transcript as UTF-8 text with its own size', async () => {
      const transcriptKey = `${RECORD.storageKey}.transcript.txt`;
      findOneOf.mockResolvedValue({ ...RECORD, transcriptKey });
      stat.mockResolvedValue({ size: 7 });

      await expect(service.openTranscript(USER_ID, MEETING_ID, FILE_ID)).resolves.toEqual({
        name: 'deck.pdf.transcript.txt',
        contentType: 'text/plain; charset=utf-8',
        size: 7,
        stream: STREAM,
      });

      expect(stat).toHaveBeenCalledWith(transcriptKey);
      expect(openRead).toHaveBeenCalledWith(transcriptKey);
    });

    it('answers 404 for an invisible meeting without touching storage', async () => {
      execute.mockResolvedValue(null);
      findOneOf.mockResolvedValue({ ...RECORD, transcriptKey: `${RECORD.storageKey}.txt` });

      await expect(service.openTranscript(USER_ID, MEETING_ID, FILE_ID)).rejects.toThrow(
        new NotFoundException('Meeting not found'),
      );
      expect(findOneOf).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(openRead).not.toHaveBeenCalled();
    });
  });
});
