'use client';

import { Card, Chip, Spinner } from '@heroui/react';
import type { MeetingDigest } from '@repo/shared';
import { useId } from 'react';

import { WarningIcon } from '@/components/icons';
import { DIGEST_OUT_OF_DATE_LABEL, digestPresentation } from '@/lib/meeting-digest';
import type { DigestStatusLine } from '@/lib/meeting-digest';
import { DigestAnnouncement } from './digest-announcement';
import { DigestContent } from './digest-content';

/** Where the latest generation stands, in the chips a file's own status uses. */
function DigestStatus({ status }: { status: DigestStatusLine }) {
  switch (status.kind) {
    case 'queued':
      return (
        <Chip color="default" variant="soft" size="sm">
          <Chip.Label>{status.label}</Chip.Label>
        </Chip>
      );
    case 'generating':
      return (
        <Chip color="default" variant="soft" size="sm">
          <Spinner size="sm" aria-hidden="true" />
          <Chip.Label>{status.label}</Chip.Label>
        </Chip>
      );
    case 'failed':
      // The chip says that it failed; why is written out under the heading, never kept in a
      // tooltip: a touch screen has neither hover nor keyboard focus to open one with.
      return (
        <Chip color="warning" variant="soft" size="sm">
          <WarningIcon />
          <Chip.Label>{status.label}</Chip.Label>
        </Chip>
      );
  }
}

/**
 * The meeting's digest: where its latest generation stands, and the last digest that was
 * stored — two things, shown side by side, because the API keeps them apart. What each
 * combination shows is `digestPresentation`'s to decide; this draws it.
 *
 * **No digest, no section.** A meeting with no transcribed recording, and one whose digest
 * was withdrawn with a recording, draw nothing here at all: no heading, no empty frame. Only
 * the status region is always in the page, which is why it sits outside the card.
 *
 * It reads the digest and asks for nothing: the page holds the stream that keeps it current
 * (`useMeetingUpdates`), and nobody is offered a control here.
 */
export function DigestSection({ digest }: { digest: MeetingDigest | null }) {
  const headingId = useId();
  const shown = digestPresentation(digest);

  return (
    <>
      <DigestAnnouncement digest={digest} />

      {shown !== null && (
        <section aria-labelledby={headingId}>
          <Card className="gap-0 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 id={headingId} className="text-lg font-semibold tracking-tight">
                  Digest
                </h2>
                {/* Said wherever a digest is shown, and only there: it is about the text
                    under it, and a status alone has no text to be wrong. */}
                {shown.content !== null && (
                  <p className="text-muted text-sm text-pretty">{shown.content.note}</p>
                )}
              </div>

              {/* The mark beside the status of what will replace it: an out-of-date digest
                  stays readable while its replacement is queued, generated, or has failed. */}
              <div className="flex flex-wrap items-center gap-2">
                {shown.content?.outOfDate === true && (
                  <Chip color="default" variant="soft" size="sm">
                    <Chip.Label>{DIGEST_OUT_OF_DATE_LABEL}</Chip.Label>
                  </Chip>
                )}
                {shown.status !== null && <DigestStatus status={shown.status} />}
              </div>
            </div>

            {shown.status?.kind === 'failed' && (
              <p className="text-muted mt-3 text-sm">{shown.status.reason}</p>
            )}

            {shown.content !== null && <DigestContent content={shown.content} />}
          </Card>
        </section>
      )}
    </>
  );
}
