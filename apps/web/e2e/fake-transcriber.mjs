/**
 * A stand-in for the Whisper service, for the browser suite: an OpenAI-shaped
 * `audio/transcriptions` endpoint on loopback that a spec tells to hold a recording's answer
 * open, fail it, or answer it with a sentence. `playwright.config.ts` starts it beside the two
 * real servers and `@repo/api`'s `start:e2e-web` points the API at it, so the application's
 * own HTTP adapter and transcription worker are what the specs run. Nothing here transcribes.
 *
 * **A reply belongs to a recording, not to "the next request".** The API never sends a file's
 * name — the upload is always `recording.mp3` — so a spec puts a marker in the bytes it
 * uploads (`recordingNamed` in `transcription.ts`) and registers the reply under it. Nothing a
 * spec arranges can then be spent on a recording another test left behind: the specs share one
 * database, and the API's worker takes whatever is oldest.
 *
 * Plain Node and no dependency, because it is started as `node e2e/fake-transcriber.mjs`
 * before anything of the workspace's is built.
 *
 * | Request                                        | Does                                       |
 * | ---------------------------------------------- | ------------------------------------------ |
 * | `GET /health`                                  | 200, for Playwright's readiness check      |
 * | `POST /v1/audio/transcriptions`                | Replies as the recording's marker says     |
 * | `PUT /control/replies` `{ marker, reply }`     | Sets a reply; settles one that was held    |
 * | `DELETE /control/replies`                      | Forgets every reply and answers what waits |
 *
 * A reply is `{ kind: 'text', text }`, `{ kind: 'error', status, body }`, or `{ kind: 'hold' }`.
 * A recording nothing was registered for is answered with `DEFAULT_TEXT` at once.
 */
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 3102;
const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';
const REPLIES_PATH = '/control/replies';
const DEFAULT_TEXT = 'An unremarkable recording.';

/** marker → reply, in the order the specs registered them. */
const replies = new Map();
/** Responses being held open → the marker that is holding them. */
const held = new Map();

/** The whole request body, or `null` when the caller hung up before sending all of it. */
async function readBody(request) {
  const chunks = [];

  try {
    for await (const chunk of request) {
      chunks.push(chunk);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks);
}

/** Answers, fails, or keeps hold of one transcription request. */
function settle(response, marker, reply) {
  if (reply.kind === 'hold') {
    held.set(response, marker);
    // The API hanging up — a lost claim, its time limit, a shutdown — is the end of the hold.
    response.on('close', () => held.delete(response));

    return;
  }

  held.delete(response);

  if (reply.kind === 'error') {
    response.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);

    return;
  }

  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(reply.text);
}

/**
 * Latin-1 maps every byte to one character, so a marker is found wherever it sits in the
 * multipart body without decoding the recording as text.
 */
function transcribe(response, body) {
  const upload = body.toString('latin1');
  const marker = [...replies.keys()].find((candidate) => upload.includes(candidate));

  settle(
    response,
    marker,
    marker === undefined ? { kind: 'text', text: DEFAULT_TEXT } : replies.get(marker),
  );
}

/** Registers a reply, and settles a request that was being held for the same recording. */
function setReply(response, body) {
  let instruction;

  try {
    instruction = JSON.parse(body.toString('utf8'));
  } catch {
    instruction = null;
  }

  const kind = instruction?.reply?.kind;

  if (typeof instruction?.marker !== 'string' || !['text', 'error', 'hold'].includes(kind)) {
    response.writeHead(400).end();

    return;
  }

  replies.set(instruction.marker, instruction.reply);

  if (kind !== 'hold') {
    for (const [waiting, marker] of held) {
      if (marker === instruction.marker) {
        settle(waiting, marker, instruction.reply);
      }
    }
  }

  response.writeHead(204).end();
}

/** Back to a fake that answers everything: no reply survives, and nothing is left waiting. */
function reset(response) {
  replies.clear();

  for (const [waiting, marker] of held) {
    settle(waiting, marker, { kind: 'text', text: DEFAULT_TEXT });
  }

  response.writeHead(204).end();
}

async function handle(request, response) {
  const body = await readBody(request);

  if (body === null) {
    response.destroy();
  } else if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  } else if (request.method === 'POST' && request.url === TRANSCRIPTIONS_PATH) {
    transcribe(response, body);
  } else if (request.method === 'PUT' && request.url === REPLIES_PATH) {
    setReply(response, body);
  } else if (request.method === 'DELETE' && request.url === REPLIES_PATH) {
    reset(response);
  } else {
    response.writeHead(404).end();
  }
}

http
  .createServer((request, response) => {
    void handle(request, response);
  })
  .listen(PORT, HOST);
