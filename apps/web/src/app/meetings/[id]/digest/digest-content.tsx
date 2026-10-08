'use client';

import { Chip, Separator } from '@heroui/react';
import type { ReactNode } from 'react';
import { useId } from 'react';

import { UserIcon } from '@/components/icons';
import { formatRelativeTime } from '@/lib/date-time';
import type { DigestActionItemLine, DigestContentView } from '@/lib/meeting-digest';

/**
 * Text a model wrote about what somebody said: wrapped wherever it has to be. A transcript
 * can hold a URL or a run of characters with no space in it, and a digest quotes it — without
 * this, one such token is wider than a phone and the page scrolls sideways.
 */
const MODEL_TEXT = '[overflow-wrap:anywhere]';

/**
 * One of the three parts: a heading, and what is under it. A `section` named by its heading,
 * so a screen reader can move from part to part and says which one it has landed in.
 */
function DigestPart({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Who an action item belongs to. The three are told apart by more than a colour: a member of
 * the meeting carries the person glyph, a name that was only spoken is a plain chip, and
 * nobody is plain muted text. "Owner:" is there for a screen reader, which meets the name
 * with nothing around it to say what it is.
 */
function Owner({ owner, ownerKind }: Pick<DigestActionItemLine, 'owner' | 'ownerKind'>) {
  return (
    <span data-owner={ownerKind} className="flex max-w-full items-center">
      <span className="sr-only">Owner: </span>
      {ownerKind === 'unassigned' ? (
        <span className="text-muted text-sm">{owner}</span>
      ) : (
        // `h-auto` and a label that wraps: a display name may be eighty characters, and a
        // chip that cannot wrap is wider than a phone. The glyph keeps its size beside a
        // wrapped label, which would otherwise squeeze it to a sliver.
        <Chip
          color={ownerKind === 'participant' ? 'accent' : 'default'}
          variant="soft"
          size="sm"
          className="h-auto max-w-full [&>svg]:shrink-0"
        >
          {ownerKind === 'participant' && <UserIcon />}
          <Chip.Label className={`whitespace-normal ${MODEL_TEXT}`}>{owner}</Chip.Label>
        </Chip>
      )}
    </span>
  );
}

/**
 * The stored digest: Summary, Action items, and Decisions, always all three. A list with
 * nothing in it is a result — the meeting decided nothing — so its heading stays and says so.
 *
 * **Every string here is rendered as a text child and nothing else.** It is a model's output
 * about untrusted speech; React escapes a text child, and that escaping is the whole of what
 * keeps markup in a digest literal. Nothing in this file may turn one into HTML.
 */
export function DigestContent({ content }: { content: DigestContentView }) {
  return (
    <div className="mt-6 flex flex-col gap-6">
      <DigestPart title="Summary">
        {/* `max-w-prose`: the card is wider than a line of prose reads well at. */}
        <p className={`max-w-prose text-pretty whitespace-pre-line ${MODEL_TEXT}`}>
          {content.summary}
        </p>
      </DigestPart>

      <DigestPart title="Action items">
        {content.noActionItems === null ? (
          <ul className="flex flex-col">
            {content.actionItems.map((item, index) => (
              <li key={item.id} className="flex flex-col">
                {index > 0 && <Separator className="my-1" />}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <span className={`flex-[1_1_16rem] ${MODEL_TEXT}`}>{item.description}</span>
                  <Owner owner={item.owner} ownerKind={item.ownerKind} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted text-sm">{content.noActionItems}</p>
        )}
      </DigestPart>

      <DigestPart title="Decisions">
        {content.noDecisions === null ? (
          <ul className="flex max-w-prose list-disc flex-col gap-2 pl-5">
            {content.decisions.map((decision) => (
              <li key={decision.id} className={MODEL_TEXT}>
                {decision.description}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted text-sm">{content.noDecisions}</p>
        )}
      </DigestPart>

      <p className="text-muted text-sm">
        Generated{' '}
        <time dateTime={content.generatedAt}>{formatRelativeTime(content.generatedAt)}</time>
      </p>
    </div>
  );
}
