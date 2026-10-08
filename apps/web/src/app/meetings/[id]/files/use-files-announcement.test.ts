import type { MeetingFile } from '@repo/shared';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useFilesAnnouncement } from './use-files-announcement';

const file = (id: string, overrides: Partial<MeetingFile> = {}): MeetingFile => ({
  id,
  meetingId: 'm1',
  uploaderId: 'u1',
  name: `${id}.mp3`,
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

/** The hook over a list a test replaces, as the stream or the poll would. */
const announce = (files: MeetingFile[]) =>
  renderHook(({ list }) => useFilesAnnouncement(list), { initialProps: { list: files } });

describe('useFilesAnnouncement', () => {
  it('says nothing about the list the page opened with', () => {
    const { result } = announce([file('a', { status: 'processing' }), file('b')]);

    expect(result.current.phrase).toBe('');
  });

  it('says how many files are still being processed when that number changes', () => {
    const { result, rerender } = announce([file('a')]);

    rerender({ list: [file('b', { status: 'uploaded' }), file('a')] });
    expect(result.current.phrase).toBe('1 file is processing.');

    rerender({ list: [file('b'), file('a')] });
    expect(result.current.phrase).toBe('All files have finished processing.');
  });

  it('keeps what it last said while the list changes in ways it does not announce', () => {
    const { result, rerender } = announce([file('a', { status: 'processing' })]);

    rerender({ list: [file('a')] });
    rerender({ list: [file('a'), file('b')] });

    expect(result.current).toEqual({ phrase: 'All files have finished processing.', sequence: 1 });
  });

  it('counts a phrase worded like the last one as a new one, so it is said again', () => {
    // A retry that fails again: the same sentence twice, with nothing said in between.
    const { result, rerender } = announce([file('a', { transcriptionStatus: 'transcribing' })]);

    rerender({ list: [file('a', { transcriptionStatus: 'failed' })] });
    expect(result.current).toEqual({ phrase: 'Transcription of a.mp3 failed.', sequence: 1 });

    rerender({ list: [file('a', { transcriptionStatus: 'queued' })] });
    rerender({ list: [file('a', { transcriptionStatus: 'failed' })] });
    expect(result.current).toEqual({ phrase: 'Transcription of a.mp3 failed.', sequence: 2 });
  });

  it('says when a transcription it was following ends, which no chip would tell a listener', () => {
    const { result, rerender } = announce([file('a', { transcriptionStatus: 'queued' })]);

    rerender({ list: [file('a', { transcriptionStatus: 'transcribing' })] });
    expect(result.current.phrase).toBe('');

    rerender({ list: [file('a', { transcriptionStatus: 'transcribed' })] });
    expect(result.current.phrase).toBe('The transcript of a.mp3 is ready.');
  });

  it('says two changes that arrive in one render as one phrase, not the second alone', () => {
    const { result, rerender } = announce([
      file('a', { status: 'processing' }),
      file('b', { transcriptionStatus: 'transcribing' }),
    ]);

    rerender({
      list: [
        file('a', { transcriptionStatus: 'queued' }),
        file('b', { transcriptionStatus: 'failed' }),
      ],
    });

    expect(result.current.phrase).toBe(
      'All files have finished processing. Transcription of b.mp3 failed.',
    );
  });
});
