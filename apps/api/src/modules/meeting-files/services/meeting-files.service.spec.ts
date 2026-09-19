import { NotFoundException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { FindVisibleMeetingQuery } from '../../meetings/queries/find-visible-meeting.query';
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
  let service: MeetingFilesService;

  beforeEach(async () => {
    execute.mockReset().mockResolvedValue(MEETING);
    findAllOf.mockReset().mockResolvedValue([RECORD]);
    findOneOf.mockReset().mockResolvedValue(RECORD);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingFilesService,
        { provide: QueryBus, useValue: { execute } },
        { provide: MeetingFileRepository, useValue: { findAllOf, findOneOf } },
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
});
