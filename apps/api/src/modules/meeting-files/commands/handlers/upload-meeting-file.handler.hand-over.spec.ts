import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventBus, QueryBus } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';

import { ContentSniffer } from '../../services/content-sniffer';
import { holdWrite, nextTurn } from '../../services/held-write.fixture';
import { MeetingFileHandOvers } from '../../services/meeting-file-hand-overs';
import { buildMeetingFileRecord } from '../../services/meeting-file-record.fixture';
import type { MeetingFileRecord } from '../../services/meeting-file.mapper';
import { MeetingFileRepository } from '../../services/meeting-file.repository';
import { MeetingFileStorage } from '../../storage/meeting-file-storage';
import { UploadMeetingFileCommand } from '../upload-meeting-file.command';
import { UploadMeetingFileHandler } from './upload-meeting-file.handler';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

/**
 * The upload as a hand-over. Everything else the handler does is the spec beside this one,
 * which is at the size limit and is why this is a file of its own.
 */
describe('UploadMeetingFileHandler: the insert and its announcement', () => {
  const createWithinCap = jest.fn();
  const publish = jest.fn();
  let handler: UploadMeetingFileHandler;
  let handOvers: MeetingFileHandOvers;
  let scratch: string;

  beforeEach(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-hand-over-'));
    fs.writeFileSync(path.join(scratch, 'upload'), 'bytes');
    createWithinCap.mockReset();
    publish.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadMeetingFileHandler,
        MeetingFileHandOvers,
        { provide: QueryBus, useValue: { execute: jest.fn().mockResolvedValue({}) } },
        { provide: MeetingFileRepository, useValue: { createWithinCap } },
        { provide: MeetingFileStorage, useValue: { put: jest.fn(), remove: jest.fn() } },
        { provide: ContentSniffer, useValue: { sniff: jest.fn().mockResolvedValue('image/png') } },
        { provide: EventBus, useValue: { publish } },
      ],
    }).compile();

    handler = moduleRef.get(UploadMeetingFileHandler);
    handOvers = moduleRef.get(MeetingFileHandOvers);
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('is a hand-over: a claim that comes back mid-insert is announced after it, not before', async () => {
    const insert = holdWrite<MeetingFileRecord>();
    const order: string[] = [];
    createWithinCap.mockReturnValue(insert.answered);
    publish.mockImplementation(() => order.push('uploaded'));

    const uploaded = handler.execute(
      new UploadMeetingFileCommand(
        USER_ID,
        MEETING_ID,
        'diagram.png',
        path.join(scratch, 'upload'),
        5,
      ),
    );
    await nextTurn();
    // The id is the handler's own, chosen before the insert: it is what the hand-over is under.
    const [row] = createWithinCap.mock.calls[0] as [{ id: string; storageKey: string }];
    // The worker's side: its claim of this file came back while the insert was still out.
    const claimed = handOvers.announced(row.id).then(() => order.push('processing'));
    await nextTurn();
    expect(order).toEqual([]);

    insert.answer(buildMeetingFileRecord({ ...row, meetingId: MEETING_ID, uploaderId: USER_ID }));
    await Promise.all([uploaded, claimed]);

    expect(order).toEqual(['uploaded', 'processing']);
  });
});
