import type { MeetingFile } from '@repo/shared';
import { describe, expect, it } from 'vitest';

import { transcriptionAnnouncement } from './meeting-file-announcements';

type Status = MeetingFile['transcriptionStatus'];

const row = (id: string, transcriptionStatus?: Status) => ({
  id,
  name: `${id}.mp3`,
  transcriptionStatus,
});

describe('transcriptionAnnouncement', () => {
  it.each<[string, Status, Status, string]>([
    ['a queued recording', 'queued', 'transcribed', 'The transcript of standup.mp3 is ready.'],
    [
      'one being transcribed',
      'transcribing',
      'transcribed',
      'The transcript of standup.mp3 is ready.',
    ],
    ['a queued recording', 'queued', 'failed', 'Transcription of standup.mp3 failed.'],
    ['one being transcribed', 'transcribing', 'failed', 'Transcription of standup.mp3 failed.'],
  ])('names %s that ended as %s → %s', (_case, before, after, phrase) => {
    expect(transcriptionAnnouncement([row('standup', before)], [row('standup', after)])).toBe(
      phrase,
    );
  });

  it.each<[string, Status, Status]>([
    ['a recording that is only moving on', 'queued', 'transcribing'],
    ['a failed one the reader sent back to the queue', 'failed', 'queued'],
    ['a transcript that was already there', 'transcribed', 'transcribed'],
    ['a failure that was already there', 'failed', 'failed'],
    ['a file that is not a recording', undefined, undefined],
  ])('says nothing for %s', (_case, before, after) => {
    expect(transcriptionAnnouncement([row('standup', before)], [row('standup', after)])).toBeNull();
  });

  it('says nothing for a recording that arrives finished: nobody was waiting on it', () => {
    expect(transcriptionAnnouncement([], [row('standup', 'transcribed')])).toBeNull();
    expect(transcriptionAnnouncement([], [row('standup', 'failed')])).toBeNull();
  });

  it('says nothing when a recording that was under way is deleted', () => {
    expect(transcriptionAnnouncement([row('standup', 'transcribing')], [])).toBeNull();
  });

  it('counts several rather than reading a list of names in one breath', () => {
    const before = ['a', 'b', 'c', 'd'].map((id) => row(id, 'transcribing'));
    const after = [
      row('a', 'transcribed'),
      row('b', 'transcribed'),
      row('c', 'failed'),
      row('d', 'failed'),
    ];

    expect(transcriptionAnnouncement(before, after)).toBe(
      '2 transcripts are ready. 2 transcriptions failed.',
    );
  });

  it('says both ends when one of each arrives together, the transcript first', () => {
    expect(
      transcriptionAnnouncement(
        [row('a', 'transcribing'), row('b', 'queued')],
        [row('a', 'failed'), row('b', 'transcribed')],
      ),
    ).toBe('The transcript of b.mp3 is ready. Transcription of a.mp3 failed.');
  });
});
