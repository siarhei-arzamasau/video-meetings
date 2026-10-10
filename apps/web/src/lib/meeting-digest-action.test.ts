import type { MeetingDigest, MeetingDigestContent, MeetingFile } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import {
  RETRY_DIGEST_LABEL,
  digestSectionView,
  offeredDigestAction,
} from './meeting-digest-action';

type ListedFile = Pick<MeetingFile, 'uploaderId' | 'transcriptionStatus'>;

const HOST = 'host';
const UPLOADER = 'uploader';
const PARTICIPANT = 'participant';

const digest = (overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version: 1,
  ...overrides,
});

/** A listed file; with no status it is a PDF, or a recording on a deployment that transcribes none. */
const file = (
  uploaderId: string,
  transcriptionStatus?: MeetingFile['transcriptionStatus'],
): ListedFile => ({
  uploaderId,
  ...(transcriptionStatus === undefined ? {} : { transcriptionStatus }),
});
const transcribed = (uploaderId: string): ListedFile => file(uploaderId, 'transcribed');

const viewer = (userId: string) => ({ userId, hostId: HOST });

const CONTENT: MeetingDigestContent = {
  summary: 'The team agreed the launch plan.',
  actionItems: [],
  decisions: [],
  generatedAt: '2026-10-08T09:00:00.000Z',
  outOfDate: false,
};

describe('offeredDigestAction', () => {
  const RETRY = digest({ status: 'failed', availableAction: 'retry' });
  const TRANSCRIBED = [transcribed(UPLOADER)];

  it('offers Retry to the host and to the uploader of a transcribed recording', () => {
    expect(offeredDigestAction(RETRY, TRANSCRIBED, viewer(HOST))).toBe('retry');
    expect(offeredDigestAction(RETRY, TRANSCRIBED, viewer(UPLOADER))).toBe('retry');
  });

  it('offers it to no other participant', () => {
    expect(offeredDigestAction(RETRY, TRANSCRIBED, viewer(PARTICIPANT))).toBeNull();
  });

  it.each<[string, ReadonlyArray<ListedFile>]>([
    ['is empty', []],
    ['holds only a file with no transcription', [file(UPLOADER)]],
    ['holds only a recording still queued', [file(UPLOADER, 'queued')]],
    ['holds only a recording being transcribed', [file(UPLOADER, 'transcribing')]],
    ['holds only a recording whose transcription failed', [file(UPLOADER, 'failed')]],
  ])('offers nothing, to the host either, while the files list %s', (_case, files) => {
    // The digest can go on saying `retry` after the meeting's last transcribed recording was
    // deleted, under the version the page already holds: the list is what knows.
    expect(offeredDigestAction(RETRY, files, viewer(HOST))).toBeNull();
    expect(offeredDigestAction(RETRY, files, viewer(UPLOADER))).toBeNull();
  });

  it('does not count a recording that is not transcribed towards who uploaded one', () => {
    const files = [transcribed(HOST), file(PARTICIPANT, 'failed'), file(UPLOADER, 'queued')];

    expect(offeredDigestAction(RETRY, files, viewer(HOST))).toBe('retry');
    expect(offeredDigestAction(RETRY, files, viewer(PARTICIPANT))).toBeNull();
    expect(offeredDigestAction(RETRY, files, viewer(UPLOADER))).toBeNull();
  });

  it.each<[string, MeetingDigest | null]>([
    ['the API has not answered yet', null],
    // Owed a digest, which is generated with nobody asking: there is nothing to offer.
    ['the meeting has recordings and no digest yet', digest({ version: 0 })],
    ['the digest is current', digest({ status: 'ready', content: CONTENT })],
    ['the digest is out of date', digest({ content: { ...CONTENT, outOfDate: true } })],
    ['the digest is queued', digest({ status: 'queued' })],
    ['the digest is being generated', digest({ status: 'generating' })],
    // The setting is off: a failure stays readable, and nobody is offered a way to repeat it.
    ['the digest failed and the API offers no retry', digest({ status: 'failed' })],
  ])('offers nothing to anybody while %s', (_case, held) => {
    expect(offeredDigestAction(held, TRANSCRIBED, viewer(HOST))).toBeNull();
    expect(offeredDigestAction(held, TRANSCRIBED, viewer(UPLOADER))).toBeNull();
  });
});

describe('digestSectionView', () => {
  it.each<[string, MeetingDigest | null]>([
    ['the API has not answered yet', null],
    ['a meeting that never had a digest', digest({ version: 0 })],
    ['a ready digest whose content is withheld', digest({ status: 'ready' })],
  ])('draws nothing at all for %s', (_case, held) => {
    expect(digestSectionView(held, null)).toBeNull();
    // Whatever is offered: a control with no status and no digest beside it says nothing
    // about what it is for, and nothing the API sends pairs the two.
    expect(digestSectionView(held, 'retry')).toBeNull();
  });

  it('puts Retry beside a failure and its reason', () => {
    const failed = digest({
      status: 'failed',
      failureReason: 'It broke.',
      availableAction: 'retry',
    });

    expect(digestSectionView(failed, 'retry')).toEqual({
      status: { kind: 'failed', label: 'Digest failed', reason: 'It broke.' },
      content: null,
      action: { label: RETRY_DIGEST_LABEL },
    });
  });

  it('keeps an earlier digest readable beside the failure of its replacement, and its Retry', () => {
    const failed = digest({
      status: 'failed',
      content: { ...CONTENT, outOfDate: true },
      availableAction: 'retry',
    });
    const shown = digestSectionView(failed, 'retry');

    expect(shown?.content).toMatchObject({ outOfDate: true, summary: CONTENT.summary });
    expect(shown?.status?.kind).toBe('failed');
    expect(shown?.action).toEqual({ label: RETRY_DIGEST_LABEL });
  });

  it('shows an out-of-date digest with no control: its replacement is nobody’s to ask for', () => {
    const stale = digest({ status: 'ready', content: { ...CONTENT, outOfDate: true } });
    const shown = digestSectionView(stale, null);

    expect(shown?.content).toMatchObject({ outOfDate: true });
    expect(shown?.action).toBeNull();
  });

  it('shows a digest with no control to a reader who is offered none', () => {
    const shown = digestSectionView(digest({ status: 'failed', availableAction: 'retry' }), null);

    expect(shown?.status?.kind).toBe('failed');
    expect(shown?.action).toBeNull();
  });

  it('words the control as the PRD does', () => {
    expect(RETRY_DIGEST_LABEL).toBe('Retry');
  });
});
