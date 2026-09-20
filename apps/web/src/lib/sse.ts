/** One event from a `text/event-stream`, as the format's fields define it. */
export interface ServerSentEvent {
  /** The `event:` field, or `message` when the server sent none — the format's default. */
  type: string;
  /** Multi-line `data:` fields joined with newlines. `''` when the event carried none. */
  data: string;
  id: string | undefined;
}

/**
 * Reads a `text/event-stream` body to its end, calling `onEvent` for each event.
 *
 * **This exists because `EventSource` cannot send an `Authorization` header.** The token
 * lives in `localStorage` and putting it in the URL is not acceptable — a URL is logged by
 * every proxy and kept in history — so the stream is opened with `fetch` and a bearer header
 * and the format is parsed here. When the `HttpOnly` cookie migration the web guide
 * anticipates lands, `EventSource` becomes possible and this file goes away.
 *
 * Resolves when the server ends the response, and rejects if the body fails mid-stream. An
 * aborted `signal` surfaces as the reader's own `AbortError` from the underlying `fetch`; a
 * caller that aborted deliberately is expected to swallow it.
 *
 * A response without a body — which `fetch` allows — resolves immediately rather than
 * throwing, because "the stream ended" is what the caller does about it either way.
 */
export async function readEventStream(
  response: Response,
  onEvent: (event: ServerSentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body;

  if (body === null) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    await pump();
  } finally {
    // Releasing the lock lets the caller — or an abort — cancel the body without the reader
    // holding it. A cancel on an already-closed stream is a no-op, not an error.
    reader.releaseLock();
  }

  async function pump(): Promise<void> {
    if (signal?.aborted === true) {
      return;
    }

    const { done, value } = await reader.read();

    if (done) {
      // A stream that ends without a trailing blank line still had a whole event in it if
      // the server wrote one; the format's terminator is what separates events, not what
      // ends them.
      flush(buffer);

      return;
    }

    // `stream: true`, so a multi-byte character split across two chunks is held back rather
    // than decoded as two replacement characters.
    buffer = consume(buffer + decoder.decode(value, { stream: true }));

    return pump();
  }

  /** Emits every complete event in `text` and returns the partial one left at the end. */
  function consume(text: string): string {
    const parts = text.split(SEPARATOR);
    // Whatever follows the last blank line is an event still arriving. Keeping it is the
    // whole reason a chunk boundary mid-event is harmless.
    const rest = parts.pop() ?? '';

    for (const part of parts) {
      flush(part);
    }

    return rest;
  }

  function flush(block: string): void {
    const event = parseEvent(block);

    if (event !== null) {
      onEvent(event);
    }
  }
}

/** `\r\n\r\n`, `\n\n`, or `\r\r` — the format allows all three, and a server may pick any. */
const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE = /\r\n|\n|\r/;

/**
 * One block between blank lines, as fields. `null` for a block that carried no field at all —
 * a keep-alive comment on its own, or the empty string a trailing separator leaves behind.
 *
 * A comment line (`: anything`) is ignored, per the format. A line with no colon is a field
 * with an empty value, and one space after the colon is part of the syntax rather than the
 * value.
 */
function parseEvent(block: string): ServerSentEvent | null {
  const data: string[] = [];
  let type = 'message';
  let id: string | undefined;
  let hasField = false;

  for (const line of block.split(LINE)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    hasField = true;

    if (field === 'event') {
      type = value;
    } else if (field === 'data') {
      data.push(value);
    } else if (field === 'id') {
      id = value;
    }
  }

  return hasField ? { type, data: data.join('\n'), id } : null;
}
