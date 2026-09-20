import { describe, expect, it, vi } from 'vitest';

import { readEventStream } from './sse';
import type { ServerSentEvent } from './sse';

/** A `Response` whose body yields exactly these chunks, in order. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

  return new Response(body);
}

async function collect(chunks: string[]): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  await readEventStream(streamOf(chunks), (event) => events.push(event));

  return events;
}

describe('readEventStream', () => {
  it('reads an event with its type, data, and id', async () => {
    await expect(
      collect(['event: file\nid: 2026-09-19T10:00:00.000Z\ndata: {"id":"a"}\n\n']),
    ).resolves.toEqual([{ type: 'file', id: '2026-09-19T10:00:00.000Z', data: '{"id":"a"}' }]);
  });

  it('joins multi-line data with newlines', async () => {
    await expect(collect(['data: one\ndata: two\ndata: three\n\n'])).resolves.toEqual([
      { type: 'message', id: undefined, data: 'one\ntwo\nthree' },
    ]);
  });

  it('defaults the type to message when the server sent no event field', async () => {
    const [event] = await collect(['data: hello\n\n']);

    expect(event?.type).toBe('message');
  });

  it('holds a partial event until the chunk that completes it', async () => {
    // The split falls inside the JSON, which is where a real 8 KB boundary would land.
    const events = await collect(['event: file\ndata: {"id":"a","nam', 'e":"deck.pdf"}\n\n']);

    expect(events).toEqual([{ type: 'file', id: undefined, data: '{"id":"a","name":"deck.pdf"}' }]);
  });

  it('holds a partial event when the boundary falls between the two blank-line newlines', async () => {
    const events = await collect(['data: one\n', '\ndata: two\n\n']);

    expect(events.map(({ data }) => data)).toEqual(['one', 'two']);
  });

  it('does not split a multi-byte character across chunks', async () => {
    const bytes = new TextEncoder().encode('data: отчёт\n\n');
    const events: ServerSentEvent[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Mid-character: `ё` is two bytes, and this cut lands between them.
        controller.enqueue(bytes.slice(0, 12));
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });

    await readEventStream(new Response(body), (event) => events.push(event));

    expect(events[0]?.data).toBe('отчёт');
  });

  it('ignores comment lines and emits nothing for a heartbeat on its own', async () => {
    await expect(collect([': ping\n\n: ping\n\ndata: real\n\n'])).resolves.toEqual([
      { type: 'message', id: undefined, data: 'real' },
    ]);
  });

  it('emits an event that carries only a type, which is what a `ping` event is', async () => {
    await expect(collect(['event: ping\nid: 2026-09-19T10:00:00.000Z\n\n'])).resolves.toEqual([
      { type: 'ping', id: '2026-09-19T10:00:00.000Z', data: '' },
    ]);
  });

  it('reads CRLF as well as LF', async () => {
    await expect(collect(['event: file\r\ndata: one\r\n\r\ndata: two\r\n\r\n'])).resolves.toEqual([
      { type: 'file', id: undefined, data: 'one' },
      { type: 'message', id: undefined, data: 'two' },
    ]);
  });

  it('treats one space after the colon as syntax, and keeps the rest', async () => {
    const [event] = await collect(['data:  two spaces\n\n']);

    expect(event?.data).toBe(' two spaces');
  });

  it('emits a final event the server did not terminate with a blank line', async () => {
    const [event] = await collect(['data: last\n']);

    expect(event?.data).toBe('last');
  });

  it('resolves when the stream ends, and calls nothing after that', async () => {
    const onEvent = vi.fn();

    await readEventStream(streamOf(['data: one\n\n']), onEvent);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('resolves for a response with no body at all', async () => {
    await expect(readEventStream(new Response(null), vi.fn())).resolves.toBeUndefined();
  });

  it('stops reading once the signal is aborted', async () => {
    const controller = new AbortController();
    const onEvent = vi.fn((): void => {
      // Abort as soon as the first event lands; the second chunk must not be read.
      controller.abort();
    });

    await readEventStream(streamOf(['data: one\n\n', 'data: two\n\n']), onEvent, controller.signal);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects when the body fails mid-stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\n'));
        controller.error(new Error('connection reset'));
      },
    });

    await expect(readEventStream(new Response(body), vi.fn())).rejects.toThrow('connection reset');
  });
});
