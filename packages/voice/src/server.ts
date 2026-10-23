import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// POST /voice with `{"text": "..."}` and the Shortcut's bearer token. The
// answer is plain text, so the Shortcut can speak the response as it is,
// errors included.

const MAX_BODY = 16 * 1024;

const digest = (text: string) => createHash('sha256').update(text).digest();

function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Comparing digests keeps the comparison constant-time whatever the length.
  return given !== '' && timingSafeEqual(digest(given), digest(token));
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

interface Options {
  token: string;
  /** `hungUp` aborts when the client goes away before the reply. */
  handle: (text: string, hungUp: AbortSignal) => Promise<string>;
}

async function respond(options: Options, request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST' || request.url !== '/voice') {
    send(response, 404, 'Not found.');
    return;
  }
  if (!authorized(request, options.token)) {
    send(response, 401, "The Shortcut's token is wrong. Check its Authorization header.");
    return;
  }
  const body = await readBody(request);
  let text = '';
  try {
    const parsed = body === null ? null : JSON.parse(body);
    if (typeof parsed?.text === 'string') text = parsed.text.trim();
  } catch {
    /* Falls through to the reply below. */
  }
  if (!text) {
    send(response, 400, "I didn't hear anything.");
    return;
  }
  const started = Date.now();
  const hungUp = new AbortController();
  // Also fires once the reply is sent, when aborting no longer matters.
  response.on('close', () => hungUp.abort());
  const reply = await options.handle(text, hungUp.signal);
  console.log(`voice: answered in ${Date.now() - started} ms`);
  send(response, 200, reply);
}

export function createVoiceServer(options: Options) {
  return createServer(async (request, response) => {
    try {
      await respond(options, request, response);
    } catch (error) {
      // Usually the iPhone hanging up mid-request; it shouldn't take the service down.
      console.error('voice: request failed:', error);
      if (!response.headersSent && !response.destroyed)
        send(response, 500, 'Something went wrong. Check the voice service log on the PC.');
    }
  });
}
