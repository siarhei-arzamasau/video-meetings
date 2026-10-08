import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { MeetingFile } from '@repo/shared';

import { MeetingFileChangedEvent } from '../../meeting-files/events/meeting-file-changed.event';
import { MeetingDigestAnnouncer } from '../services/meeting-digest-announcer';
import { MeetingDigestRepository } from '../services/meeting-digest.repository';
import { PendingDigestRequests } from '../services/pending-digest-requests';
import { RequestDigestWhenTranscribedHandler } from './request-digest-when-transcribed.handler';

const MEETING_ID = '44444444-4444-4444-8444-444444444444';

const file = (overrides: Partial<MeetingFile>): MeetingFile => ({
  id: '55555555-5555-4555-8555-555555555555',
  meetingId: MEETING_ID,
  uploaderId: '11111111-1111-4111-8111-111111111111',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 1024,
  status: 'ready',
  createdAt: '2026-10-08T09:00:00.000Z',
  ...overrides,
});

const TRANSCRIBED = file({ transcriptionStatus: 'transcribed', transcriptPath: '/transcript' });

describe('RequestDigestWhenTranscribedHandler', () => {
  const request = jest.fn();
  const noteUncoveredRecording = jest.fn();
  const announce = jest.fn();
  let enabled: boolean;
  let pending: PendingDigestRequests;
  let handler: RequestDigestWhenTranscribedHandler;

  /** Hands the handler a file event, as the bus does: synchronously, and without waiting. */
  const publish = (announced: MeetingFile): void =>
    handler.handle(new MeetingFileChangedEvent(MEETING_ID, announced));

  beforeEach(async () => {
    enabled = true;
    request.mockReset().mockResolvedValue(undefined);
    noteUncoveredRecording.mockReset().mockResolvedValue(false);
    announce.mockReset().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestDigestWhenTranscribedHandler,
        PendingDigestRequests,
        { provide: MeetingDigestRepository, useValue: { request, noteUncoveredRecording } },
        { provide: MeetingDigestAnnouncer, useValue: { announce } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback: unknown) =>
              key === 'MEETING_DIGEST_ENABLED' ? enabled : fallback,
          },
        },
      ],
    }).compile();

    handler = moduleRef.get(RequestDigestWhenTranscribedHandler);
    pending = moduleRef.get(PendingDigestRequests);
  });

  it("asks for the meeting's digest when one of its recordings has just been transcribed", async () => {
    publish(TRANSCRIBED);
    await pending.settled();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(MEETING_ID);
  });

  it.each([
    ['a PDF that became ready', file({ contentType: 'application/pdf' })],
    ['a recording that was queued', file({ transcriptionStatus: 'queued' })],
    ['a recording being transcribed', file({ transcriptionStatus: 'transcribing' })],
    ['a recording whose transcription failed', file({ transcriptionStatus: 'failed' })],
    ['an upload not yet processed', file({ status: 'uploaded' })],
    // A delete announces the row as it was, transcription status and all.
    ['a transcribed recording that was deleted', { ...TRANSCRIBED, status: 'deleted' as const }],
  ])('asks for nothing for %s', async (_case, announced) => {
    publish(announced);
    await pending.settled();

    expect(request).not.toHaveBeenCalled();
    expect(noteUncoveredRecording).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces the digest once the request has been written, and not before', async () => {
    const order: string[] = [];
    request.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('written');
    });
    announce.mockImplementation(async () => {
      order.push('announced');
    });

    publish(TRANSCRIBED);
    await pending.settled();

    expect(order).toEqual(['written', 'announced']);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MEETING_ID);
  });

  it('switched off, moves the version of a stored digest the recording is not in, and announces it', async () => {
    enabled = false;
    noteUncoveredRecording.mockResolvedValue(true);

    publish(TRANSCRIBED);
    await pending.settled();

    expect(request).not.toHaveBeenCalled();
    expect(noteUncoveredRecording).toHaveBeenCalledWith(MEETING_ID);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(MEETING_ID);
  });

  it('switched off, announces nothing for a meeting with no stored digest: nothing changed', async () => {
    enabled = false;

    publish(TRANSCRIBED);
    await pending.settled();

    expect(noteUncoveredRecording).toHaveBeenCalledWith(MEETING_ID);
    expect(announce).not.toHaveBeenCalled();
  });

  it('asks for nothing while the digest is switched off, and asks again once it is on', async () => {
    enabled = false;
    publish(TRANSCRIBED);
    await pending.settled();
    expect(request).not.toHaveBeenCalled();

    // Read per event, not once at construction.
    enabled = true;
    publish(TRANSCRIBED);
    await pending.settled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('has registered its request by the time it returns, so shutdown and drain wait for it', async () => {
    let written = false;
    request.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      written = true;
    });

    // Not awaited: the bus does not wait for a handler either.
    publish(TRANSCRIBED);
    expect(written).toBe(false);

    await pending.settled();
    expect(written).toBe(true);
  });

  it('logs a request that fails and lets nothing escape: the transcription is not undone', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    request.mockRejectedValue(new Error('connection terminated'));

    expect(() => publish(TRANSCRIBED)).not.toThrow();
    await expect(pending.settled()).resolves.toBeUndefined();

    // Nothing was written, so there is nothing to announce.
    expect(announce).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`Digest of meeting ${MEETING_ID}`),
      expect.stringContaining('connection terminated'),
    );
    logged.mockRestore();
  });
});
