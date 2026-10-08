import type { MeetingDigest, MeetingDigestContent, MeetingDigestStatus } from '@repo/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DigestSection } from './digest-section';

const CONTENT: MeetingDigestContent = {
  summary: 'The team agreed the launch plan.',
  actionItems: [
    {
      id: 'a1',
      description: 'Send the deck.',
      owner: { kind: 'participant', userId: 'u2', displayName: 'Ada Lovelace' },
    },
    { id: 'a2', description: 'Call the venue.', owner: { kind: 'name', name: 'Grace' } },
    { id: 'a3', description: 'Book the room.' },
  ],
  decisions: [{ id: 'd1', description: 'Ship on Friday.' }],
  generatedAt: '2026-10-08T09:00:00.000Z',
  outOfDate: false,
};

const digest = (overrides: Partial<MeetingDigest> = {}): MeetingDigest => ({
  meetingId: 'm1',
  version: 1,
  ...overrides,
});

const READY = digest({ status: 'ready', content: CONTENT });

const section = (): HTMLElement => screen.getByRole('region', { name: 'Digest' });
const part = (name: string): HTMLElement => within(section()).getByRole('region', { name });

afterEach(() => {
  cleanup();
});

describe('DigestSection', () => {
  it.each<[string, MeetingDigest | null]>([
    ['the API has not answered yet', null],
    ['the meeting never had a digest', digest({ version: 0 })],
    ['the digest was withdrawn and nothing replaces it yet', digest({ status: 'ready' })],
  ])('draws no section at all while %s', (_case, current) => {
    const { container } = render(<DigestSection digest={current} />);

    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    // Only the status region is there, and it is silent.
    expect(container.textContent).toBe('');
  });

  it.each<[MeetingDigestStatus, string]>([
    ['queued', 'Digest queued'],
    ['generating', 'Generating digest…'],
  ])('says a %s digest is on its way, with nothing under it', (status, label) => {
    render(<DigestSection digest={digest({ status })} />);

    expect(within(section()).getByText(label)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
    // The note is about a digest, and there is none to read yet.
    expect(screen.queryByText(/AI-generated/)).toBeNull();
  });

  it('shows a failed digest with the reason the API gave, written out', () => {
    render(
      <DigestSection
        digest={digest({
          status: 'failed',
          failureReason: 'The recordings of this meeting are too long to turn into one digest.',
        })}
      />,
    );

    expect(within(section()).getByText('Digest failed')).toBeTruthy();
    expect(
      within(section()).getByText(
        'The recordings of this meeting are too long to turn into one digest.',
      ),
    ).toBeTruthy();
    // Phase 7's: nobody is offered a control here yet.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the three parts of a digest under their headings, and the AI note', () => {
    render(<DigestSection digest={READY} />);

    expect(within(part('Summary')).getByText('The team agreed the launch plan.')).toBeTruthy();
    expect(within(part('Decisions')).getAllByRole('listitem')).toHaveLength(1);
    expect(within(part('Decisions')).getByText('Ship on Friday.')).toBeTruthy();
    expect(within(part('Action items')).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(section()).getByText(
        "AI-generated from the transcripts of this meeting's recordings. It may contain mistakes.",
      ),
    ).toBeTruthy();
    // Ready is said by showing it.
    expect(screen.queryByText('Digest queued')).toBeNull();
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('names each action item’s owner: a participant, a name as spoken, or nobody', () => {
    render(<DigestSection digest={READY} />);
    const [linked, spoken, unowned] = within(part('Action items')).getAllByRole('listitem');

    expect(linked?.textContent).toBe('Send the deck.Owner: Ada Lovelace');
    expect(spoken?.textContent).toBe('Call the venue.Owner: Grace');
    expect(unowned?.textContent).toBe('Book the room.Owner: Unassigned');
    // Told apart by more than a colour: a member of the meeting is marked as one.
    expect(linked?.querySelector('[data-owner="participant"]')).not.toBeNull();
    expect(spoken?.querySelector('[data-owner="name"]')).not.toBeNull();
    expect(unowned?.querySelector('[data-owner="unassigned"]')).not.toBeNull();
  });

  it('says so under a heading whose list is empty, rather than dropping the heading', () => {
    render(
      <DigestSection
        digest={digest({
          status: 'ready',
          content: { ...CONTENT, actionItems: [], decisions: [] },
        })}
      />,
    );

    expect(within(part('Action items')).getByText('No action items were identified')).toBeTruthy();
    expect(within(part('Decisions')).getByText('No decisions were recorded')).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toEqual([]);
  });

  it.each<[MeetingDigestStatus, string]>([
    ['queued', 'Digest queued'],
    ['generating', 'Generating digest…'],
    ['failed', 'Digest failed'],
  ])('keeps an out-of-date digest readable beside a replacement that is %s', (status, label) => {
    render(<DigestSection digest={digest({ status, content: { ...CONTENT, outOfDate: true } })} />);

    expect(within(section()).getByText('Out of date')).toBeTruthy();
    expect(within(section()).getByText(label)).toBeTruthy();
    expect(within(part('Summary')).getByText('The team agreed the launch plan.')).toBeTruthy();
  });

  it('renders markup in a digest as the characters it is made of', () => {
    const markup = '<img src=x onerror="window.pwned=1"><b>bold</b> &amp;';
    const { container } = render(
      <DigestSection
        digest={digest({
          status: 'ready',
          content: {
            ...CONTENT,
            summary: markup,
            actionItems: [{ id: 'a1', description: markup, owner: { kind: 'name', name: markup } }],
            decisions: [{ id: 'd1', description: markup }],
          },
        })}
      />,
    );

    // Summary, an action item, its owner, and a decision: four places, all of them text.
    expect(screen.getAllByText(markup, { exact: false })).toHaveLength(4);
    expect(container.querySelector('img, b')).toBeNull();
  });

  it('keeps the paragraphs a summary was written in', () => {
    render(
      <DigestSection
        digest={digest({
          status: 'ready',
          content: { ...CONTENT, summary: 'First.\n\nSecond.' },
        })}
      />,
    );

    expect(within(part('Summary')).getByText(/First\./).className).toContain('whitespace-pre-line');
  });
});

/** The status region, and a way to hand the section the next digest as the stream would. */
function mount(first: MeetingDigest | null) {
  const { container, rerender } = render(<DigestSection digest={first} />);
  const region = container.querySelector('output');

  if (region === null) {
    throw new Error('The section has no status region.');
  }

  return { region, show: (next: MeetingDigest) => rerender(<DigestSection digest={next} />) };
}

describe('the digest section’s status region', () => {
  it('is there before the section is, read whole, and silent about how the page opened', () => {
    const { region, show } = mount(null);

    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.textContent).toBe('');

    // The first answer is what the meeting already was: nobody's news.
    show(READY);

    expect(region.textContent).toBe('');
  });

  it('says a digest arrived, and was then removed, without the reader looking', () => {
    const { region, show } = mount(null);

    show(digest({ status: 'generating' }));
    show(READY);
    expect(region.textContent).toBe('The meeting digest is ready.');

    // Its recording was deleted: the section goes, and the region that outlives it says so.
    show(digest({ version: 2 }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(region.textContent).toBe('The meeting digest was removed.');
  });

  it('puts a failure worded like the last one in a new node, so it is spoken again', () => {
    const { region, show } = mount(digest({ status: 'generating' }));

    show(digest({ status: 'failed' }));
    const first = region.firstElementChild;
    expect(region.textContent).toBe('Generating the meeting digest failed.');

    show(digest({ status: 'queued' }));
    show(digest({ status: 'failed' }));

    expect(region.textContent).toBe('Generating the meeting digest failed.');
    expect(region.firstElementChild).not.toBe(first);
  });
});
