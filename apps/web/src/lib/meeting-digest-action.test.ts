import type { MeetingDigest, MeetingDigestContent, MeetingFile } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import {
  GENERATE_DIGEST_LABEL,
  NO_DIGEST_YET_LABEL,
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
  const GENERATE = digest({ availableAction: 'generate' });
  const RETRY = digest({ status: 'failed', availableAction: 'retry' });
  const TRANSCRIBED = [transcribed(UPLOADER)];

  it.each<[string, MeetingDigest, 'generate' | 'retry']>([
    ['Generate', GENERATE, 'generate'],
    ['Retry', RETRY, 'retry'],
  ])(
    'offers %s to the host and to the uploader of a transcribed recording',
    (_label, held, action) => {
      expect(offeredDigestAction(held, TRANSCRIBED, viewer(HOST))).toBe(action);
      expect(offeredDigestAction(held, TRANSCRIBED, viewer(UPLOADER))).toBe(action);
    },
  );

  it.each<[string, MeetingDigest]>([
    ['Generate', GENERATE],
    ['Retry', RETRY],
  ])('offers %s to no other participant', (_label, held) => {
    expect(offeredDigestAction(held, TRANSCRIBED, viewer(PARTICIPANT))).toBeNull();
  });

  it.each<[string, ReadonlyArray<ListedFile>]>([
    ['is empty', []],
    ['holds only a file with no transcription', [file(UPLOADER)]],
    ['holds only a recording still queued', [file(UPLOADER, 'queued')]],
    ['holds only a recording being transcribed', [file(UPLOADER, 'transcribing')]],
    ['holds only a recording whose transcription failed', [file(UPLOADER, 'failed')]],
  ])('offers nothing, to the host either, while the files list %s', (_case, files) => {
    // The digest can go on saying `generate` after the meeting's last transcribed recording
    // was deleted, under the version the page already holds: the list is what knows.
    expect(offeredDigestAction(GENERATE, files, viewer(HOST))).toBeNull();
    expect(offeredDigestAction(GENERATE, files, viewer(UPLOADER))).toBeNull();
  });

  it('does not count a recording that is not transcribed towards who uploaded one', () => {
    const files = [transcribed(HOST), file(PARTICIPANT, 'failed'), file(UPLOADER, 'queued')];

    expect(offeredDigestAction(GENERATE, files, viewer(HOST))).toBe('generate');
    expect(offeredDigestAction(GENERATE, files, viewer(PARTICIPANT))).toBeNull();
    expect(offeredDigestAction(GENERATE, files, viewer(UPLOADER))).toBeNull();
  });

  it.each<[string, MeetingDigest | null]>([
    ['the API has not answered yet', null],
    ['the meeting never had a digest and the setting is off', digest({ version: 0 })],
    ['the digest is current', digest({ status: 'ready', content: CONTENT })],
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
    // What the API would accept is not an offer: this reader may not ask.
    ['an action this reader is not offered', digest({ availableAction: 'generate' })],
  ])('draws nothing at all for %s, when nothing is offered', (_case, held) => {
    expect(digestSectionView(held, null)).toBeNull();
  });

  it.each<[string, MeetingDigest]>([
    [
      'a meeting whose recordings were transcribed with the setting off',
      digest({ availableAction: 'generate' }),
    ],
    [
      'a digest withheld by a delete nothing reacted to',
      digest({ status: 'ready', availableAction: 'generate' }),
    ],
  ])('draws the control and a sentence in place of a digest for %s', (_case, held) => {
    expect(digestSectionView(held, 'generate')).toEqual({
      status: null,
      content: null,
      action: { kind: 'generate', label: GENERATE_DIGEST_LABEL },
      notice: NO_DIGEST_YET_LABEL,
    });
  });

  it('puts Retry beside a failure and its reason, with no sentence of its own', () => {
    const failed = digest({
      status: 'failed',
      failureReason: 'It broke.',
      availableAction: 'retry',
    });

    expect(digestSectionView(failed, 'retry')).toEqual({
      status: { kind: 'failed', label: 'Digest failed', reason: 'It broke.' },
      content: null,
      action: { kind: 'retry', label: RETRY_DIGEST_LABEL },
      notice: null,
    });
  });

  it('puts Generate beside an out-of-date digest nothing is replacing', () => {
    const stale = digest({ content: { ...CONTENT, outOfDate: true }, availableAction: 'generate' });
    const shown = digestSectionView(stale, 'generate');

    expect(shown?.content).toMatchObject({ outOfDate: true, summary: CONTENT.summary });
    expect(shown?.action).toEqual({ kind: 'generate', label: GENERATE_DIGEST_LABEL });
    expect(shown?.notice).toBeNull();
  });

  it('shows a digest with no control to a reader who is offered none', () => {
    const shown = digestSectionView(digest({ status: 'failed', availableAction: 'retry' }), null);

    expect(shown?.status?.kind).toBe('failed');
    expect(shown?.action).toBeNull();
    expect(shown?.notice).toBeNull();
  });

  it('words the two controls as the PRD does', () => {
    expect(GENERATE_DIGEST_LABEL).toBe('Generate digest');
    expect(RETRY_DIGEST_LABEL).toBe('Retry');
  });
});
