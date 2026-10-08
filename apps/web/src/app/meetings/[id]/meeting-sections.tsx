'use client';

import type { Meeting, User } from '@repo/shared';

import { DigestSection } from './digest/digest-section';
import { FilesSection } from './files/files-section';
import { useMeetingUpdates } from './use-meeting-updates';

interface MeetingSectionsProps {
  token: string;
  meeting: Meeting;
  user: User;
  onUnauthorized(): void;
}

/**
 * What a meeting page shows under its header, and the one place its live connection is held.
 *
 * `useMeetingUpdates` is called here rather than inside a section because the stream it
 * opens is the meeting's: it carries the files and the digest, and a section that owned it
 * would be the only one that could hear it.
 *
 * **The digest is drawn under the files, and that order is deliberate.** It appears, grows
 * from a status to three lists, and disappears with no action from the reader — often while
 * they are in the files above it, where the upload that caused it was made. Above the files
 * it would push the list they are using down the page each time; under them it moves nothing.
 */
export function MeetingSections({ token, meeting, user, onUnauthorized }: MeetingSectionsProps) {
  const { files, digest } = useMeetingUpdates(token, meeting.id, onUnauthorized);

  return (
    <>
      <FilesSection
        token={token}
        meeting={meeting}
        user={user}
        files={files}
        onUnauthorized={onUnauthorized}
      />
      <DigestSection digest={digest} />
    </>
  );
}
