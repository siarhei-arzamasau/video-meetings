import type { Meeting, MeetingDigest, MeetingFile, User } from '@repo/shared';
import { act, render, screen, within } from '@testing-library/react';
import { vi } from 'vitest';

import { fetchMeetingDigest, listMeetingFiles } from '@/lib/api-client';
import { watchMeetingFiles } from '@/lib/meeting-file-stream';

import { MeetingSections } from './meeting-sections';

/*
 * What the specs of the digest's control share: a meeting of three people, one transcribed
 * recording, and the page's end of the stream. Each spec file mocks `@/lib/api-client` and
 * `@/lib/meeting-file-stream` itself — `vi.mock` is hoisted per file — and this only reads
 * the mocks they made.
 */
const person = (id: string): User => ({
  id,
  email: `${id}@example.com`,
  displayName: id,
  avatarVersion: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
});

export const HOST = person('host');
export const UPLOADER = person('uploader');
export const PARTICIPANT = person('participant');

export const MEETING: Meeting = {
  id: 'm1',
  title: 'Launch review',
  status: 'scheduled',
  hostId: HOST.id,
  scheduledAt: '2026-10-02T10:00:00.000Z',
  participantIds: [UPLOADER.id, PARTICIPANT.id],
};

/** A participant's recording, transcribed: what makes its uploader one of the two who may ask. */
export const RECORDING: MeetingFile = {
  id: 'f1',
  meetingId: MEETING.id,
  uploaderId: UPLOADER.id,
  name: 'launch.mp3',
  contentType: 'audio/mpeg',
  size: 3_346,
  status: 'ready',
  transcriptionStatus: 'transcribed',
  transcriptPath: '/meetings/m1/files/f1/transcript',
  createdAt: '2026-10-01T10:00:00.000Z',
};

export const digest = (version: number, overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: MEETING.id,
  version,
  ...overrides,
});

/** Recordings transcribed while the setting was off: nothing stored, and Generate on offer. */
export const NEVER_GENERATED = digest(0, { availableAction: 'generate' });
export const FAILED = digest(4, {
  status: 'failed',
  failureReason: 'The digest could not be generated.',
  availableAction: 'retry',
});

export const onUnauthorized = vi.fn();

const nothing = (): void => undefined;

/** The page's end of the stream: what a spec calls to have an event arrive. */
export const stream: {
  file: (file: MeetingFile) => void;
  digest: (digest: MeetingDigest) => void;
} = { file: nothing, digest: nothing };

/** A stream that is open and silent until a spec says otherwise. */
export function connectStream(): void {
  vi.mocked(watchMeetingFiles).mockImplementation(({ onFile, onDigest }) => {
    stream.file = onFile;
    stream.digest = onDigest ?? nothing;

    return new Promise<void>(() => undefined);
  });
}

export function deliverDigests(...events: MeetingDigest[]): void {
  act(() => {
    for (const event of events) {
      stream.digest({ ...event });
    }
  });
}

interface Page {
  viewer: User;
  held: MeetingDigest;
  files?: MeetingFile[];
}

/** The meeting page under its header, as `viewer` sees it, once its files are listed. */
export async function renderSections({ viewer, held, files = [RECORDING] }: Page): Promise<void> {
  vi.mocked(listMeetingFiles).mockResolvedValue(files);
  vi.mocked(fetchMeetingDigest).mockResolvedValue(held);

  render(
    <MeetingSections
      token="a-signed-jwt"
      meeting={MEETING}
      user={viewer}
      onUnauthorized={onUnauthorized}
    />,
  );

  await screen.findByRole('list', { name: 'Files' });
  // One more turn, for the digest's answer to land beside the list's.
  await act(async () => {
    await Promise.resolve();
  });
}

export const digestRegion = (): HTMLElement | null =>
  screen.queryByRole('region', { name: 'Digest' });

/** The section's buttons of one name. Scoped: a failed row above it has a Retry of its own. */
export function digestButtons(name: string): HTMLElement[] {
  const region = digestRegion();

  return region === null ? [] : within(region).queryAllByRole('button', { name });
}

export function digestButton(name: string): HTMLButtonElement {
  const [button] = digestButtons(name);

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`The digest section has no "${name}" button.`);
  }

  return button;
}
