import type { MeetingFile } from '@repo/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FilesAnnouncement } from './files-announcement';

const recording = (overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id: 'f1',
  meetingId: 'm1',
  uploaderId: 'u1',
  name: 'standup.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

const FAILED_PHRASE = 'Transcription of standup.mp3 failed.';

/** The region, and a way to hand it the next list as the stream or the poll would. */
function mount(first: MeetingFile) {
  const { container, rerender } = render(<FilesAnnouncement files={[first]} />);
  const region = container.querySelector('output');

  if (region === null) {
    throw new Error('The section has no status region.');
  }

  return {
    region,
    show: (next: MeetingFile) => rerender(<FilesAnnouncement files={[next]} />),
  };
}

afterEach(() => {
  cleanup();
});

/** What the page changes, which is all a screen reader goes by. The wording is the hook's. */
describe('the files section\u2019s status region', () => {
  it('is one polite region, read whole, and empty until something changes', () => {
    const { region } = mount(recording({ transcriptionStatus: 'transcribing' }));

    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toBe('');
  });

  it('puts a phrase worded like the last one in a new node, so it is spoken again', () => {
    const { region, show } = mount(recording({ transcriptionStatus: 'transcribing' }));

    show(recording({ transcriptionStatus: 'failed' }));
    const first = region.firstElementChild;
    expect(region.textContent).toBe(FAILED_PHRASE);

    // Retried, and failed again: the same words, and nothing said in between.
    show(recording({ transcriptionStatus: 'queued' }));
    show(recording({ transcriptionStatus: 'failed' }));

    expect(region.textContent).toBe(FAILED_PHRASE);
    expect(region.firstElementChild).not.toBe(first);
  });

  it('leaves the node alone while the list changes in ways it does not announce', () => {
    const { region, show } = mount(recording({ transcriptionStatus: 'transcribing' }));

    show(recording({ transcriptionStatus: 'failed' }));
    const said = region.firstElementChild;
    show(recording({ transcriptionStatus: 'queued' }));

    // Nothing new to say, so nothing for a screen reader to repeat.
    expect(region.firstElementChild).toBe(said);
  });
});
