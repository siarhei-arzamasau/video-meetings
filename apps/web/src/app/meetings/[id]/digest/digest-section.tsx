'use client';

import { Card, Chip, Spinner } from '@heroui/react';
import type { MeetingDigest } from '@repo/shared';
import { useId, useRef } from 'react';

import { WarningIcon } from '@/components/icons';
import { DIGEST_OUT_OF_DATE_LABEL } from '@/lib/meeting-digest';
import type { DigestStatusLine } from '@/lib/meeting-digest';
import { digestSectionView } from '@/lib/meeting-digest-action';
import { DigestActionButtons } from './digest-action-buttons';
import { DigestAnnouncement } from './digest-announcement';
import { DigestContent } from './digest-content';
import type { DigestActionControl } from './use-digest-action';

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

interface DigestSectionProps {
  digest: MeetingDigest | null;
  /**
   * The reader's control and its request, from `useDigestAction`. Left out, the section is
   * the one a reader who may ask for nothing sees.
   */
  action?: DigestActionControl;
}

/**
 * The meeting's digest: where its latest generation stands, and the last digest that was
 * stored — two things, shown side by side, because the API keeps them apart. What each
 * combination shows is `digestSectionView`'s to decide; this draws it.
 *
 * **No digest, no section.** A meeting with no transcribed recording, one whose recordings
 * have no digest yet, and one whose digest was withdrawn with a recording draw nothing here
 * at all: no heading, no empty frame, and nothing to press — a digest is generated with
 * nobody asking. Only the status region is always in the page, which is why it sits outside
 * the card.
 *
 * It holds no connection and makes no decision: the page holds the stream that keeps the
 * digest current (`useMeetingUpdates`), and who is offered "Retry" beside a digest that
 * failed is `useDigestAction`'s, handed in as `action`.
 *
 * **A press moves focus to the heading before anything else.** The control is disabled
 * while its request is on its way and gone once it is taken, and a button removed while it
 * holds focus drops a keyboard reader back at the top of the page. The heading is where the
 * status they asked for is about to appear; if the request fails instead, the control is the
 * next tab stop.
 */
export function DigestSection({ digest, action }: DigestSectionProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = digestSectionView(digest, action?.offered ?? null);
  const error = action?.error ?? null;

  return (
    <>
      <DigestAnnouncement digest={digest} />

      {shown !== null && (
        <section aria-labelledby={headingId}>
          <Card className="gap-0 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2
                  ref={heading}
                  id={headingId}
                  tabIndex={-1}
                  className="focus-visible:ring-focus -mx-1 rounded px-1 text-lg font-semibold tracking-tight outline-none focus-visible:ring-2"
                >
                  Digest
                </h2>
                {/* Said wherever a digest is shown, and only there: it is about the text
                    under it, and a status alone has no text to be wrong. */}
                {shown.content !== null && (
                  <p className="text-muted text-sm text-pretty">{shown.content.note}</p>
                )}
              </div>

              {/* The mark beside the status of what will replace it: an out-of-date digest
                  stays readable while its replacement is queued, generated, or has failed.
                  `flex-wrap`: two chips and two buttons are wider than a phone. */}
              <div className="flex flex-wrap items-center gap-2">
                {shown.content?.outOfDate === true && (
                  <Chip color="default" variant="soft" size="sm">
                    <Chip.Label>{DIGEST_OUT_OF_DATE_LABEL}</Chip.Label>
                  </Chip>
                )}
                {shown.status !== null && <DigestStatus status={shown.status} />}
                <DigestActionButtons
                  action={shown.action}
                  isRequesting={action?.isRequesting === true}
                  hasError={error !== null}
                  onRequest={() => {
                    heading.current?.focus();
                    action?.request();
                  }}
                  onDismiss={() => action?.dismiss()}
                />
              </div>
            </div>

            {shown.status?.kind === 'failed' && (
              <p className="text-muted mt-3 text-sm">{shown.status.reason}</p>
            )}
            {error !== null && (
              <p className="text-danger-soft-foreground mt-3 text-sm" role="alert">
                {error}
              </p>
            )}

            {shown.content !== null && <DigestContent content={shown.content} />}
          </Card>
        </section>
      )}
    </>
  );
}
