import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from './config.js';
import { BrowserExecutor } from './browser.js';
import { Agent } from './agent.js';
import { Controller } from './controller.js';
import { interpreter } from './understanding.js';
import { Ownership } from './ownership.js';
import { Attention } from './actions.js';
const browser = new BrowserExecutor(config.BROWSER_CHANNEL);
let saved: { owner?: string; conversation: ReturnType<Controller['snapshot']> } | undefined;
try { saved = JSON.parse(await readFile(resolve(process.env.SESSION_FILE || '.session.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The saved session could not be read. Restore or remove .session.json before starting.'); }
const ownership = new Ownership(saved?.owner);
let saving = Promise.resolve();
function persist() {
  const data = JSON.stringify({ owner: ownership.snapshot(), conversation: controller.snapshot() });
  saving = saving.then(async () => { await writeFile(resolve((process.env.SESSION_FILE || '.session.json') + '.tmp'), data, { mode: 0o600 }); await rename(resolve((process.env.SESSION_FILE || '.session.json') + '.tmp'), resolve(process.env.SESSION_FILE || '.session.json')); }).catch(() => { console.error('Could not save the local conversation. Check workspace permissions.'); });
}
const clients = new Set<ServerResponse>();
let resetting = false;
const client = process.env.OPENAI_API_KEY ? new OpenAI({ maxRetries: 0, timeout: config.API_TIMEOUT_MS }) : undefined;
const create: ConstructorParameters<typeof Agent>[0]['create'] = async (body, signal) => {
  if (!client) throw new Attention('Set OPENAI_API_KEY in .env and restart the local backend.');
  return client.responses.create(body, { signal });
};
function state() { return { ...controller.state, keyConfigured: !!client }; }
function publish() { persist(); for (const stream of clients) stream.write(`data: ${JSON.stringify(state())}\n\n`); }
const agent = new Agent({ browser, model: config.OPENAI_MODEL, create,
  maxActions: config.MAX_ACTIONS, maxTurns: config.MAX_TURNS, maxRuntimeMs: config.MAX_RUNTIME_MS,
  onChange: state => controller.agentChanged(state), onMilestone: milestone => controller.milestone(milestone),
  artifact: async (runId, name, data) => {
    const directory = resolve('artifacts', runId); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(directory, name), name.endsWith('.png') ? Buffer.from(String(data), 'base64') : JSON.stringify(data, null, 2), { mode: 0o600 });
  },
});
const controller = new Controller({ browser, agent, understand: interpreter(create, config.OPENAI_MODEL), onChange: publish });
if (saved) controller.restore(saved.conversation);
browser.onClosed = () => controller.browserClosed();
function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage) {
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 16000) throw new Error('Request too large.'); }
  return JSON.parse(value || '{}');
}
const hosts = new Set([`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`]);
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!hosts.has(req.headers.host || '') || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local requests only.' });
  if (req.headers.origin && ![...hosts].map(h => `http://${h}`).includes(req.headers.origin)) return json(res, 403, { error: 'Origin not allowed.' });
  const path = new URL(req.url || '/', `http://127.0.0.1:${config.PORT}`).pathname;
  try {
    if (req.method === 'GET') {
      if (path === '/api/session') {
        if (resetting) throw new Attention('Starting a new session. Please try again in a moment.');
        try { res.setHeader('Set-Cookie', ownership.connect(req.headers.cookie)); }
        catch (error) { if (!(error instanceof Attention)) throw error; return json(res, 409, { error: error.message, resetToken: ownership.resetToken }); }
        persist(); return json(res, 200, { token: ownership.token, resetToken: ownership.resetToken, state: state() });
      }
      if (path.startsWith('/api/') && !ownership.owns(req.headers.cookie)) return json(res, 403, { error: 'Open the original TinkerCUA chat to access this conversation.' });
      if (path === '/api/state') return json(res, 200, state());
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        clients.add(res); res.write(`data: ${JSON.stringify(state())}\n\n`); req.on('close', () => clients.delete(res)); return;
      }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (files[path]) { const [file, type] = files[path]; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(await readFile(resolve('public', file))); return; }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'POST' && path === '/api/new-session') {
      if (req.headers['x-tinkercua-token'] !== ownership.resetToken) return json(res, 403, { error: 'Refresh this page before starting a new session.' });
      if (resetting) throw new Attention('A new session is already being created.');
      controller.assertCanReset(); resetting = true;
      try {
        const archive = JSON.stringify(controller.snapshot(), null, 2);
        await mkdir(resolve('artifacts', 'sessions'), { recursive: true, mode: 0o700 });
        await writeFile(resolve('artifacts', 'sessions', `${controller.state.id}.json`), archive, { mode: 0o600 });
        for (const stream of clients) { stream.write('event: session-ended\ndata: {}\n\n'); stream.end(); }
        clients.clear();
        res.setHeader('Set-Cookie', ownership.newSession(ownership.resetToken)); controller.newSession(); await saving;
        return json(res, 200, { token: ownership.token, resetToken: ownership.resetToken, state: state() });
      } finally { resetting = false; }
    }
    if (req.method !== 'POST' || !ownership.owns(req.headers.cookie) || req.headers['x-tinkercua-token'] !== ownership.token) return json(res, 403, { error: 'Refresh this page before sending commands.' });
    if (resetting) throw new Attention('Starting a new session. Please wait.');
    const data = await body(req);
    // Recheck after reading the body: a reset may have completed while it arrived.
    if (resetting || !ownership.owns(req.headers.cookie) || req.headers['x-tinkercua-token'] !== ownership.token) return json(res, 409, { error: 'The session changed. Refresh this page.' });
    let work: Promise<void> | undefined;
    if (path === '/api/message') {
      const { prompt, requestId } = z.object({ prompt: z.string().trim().min(1).max(2200), requestId: z.string().uuid() }).parse(data);
      work = controller.message(prompt, requestId);
    } else if (path === '/api/login-check') work = controller.loginCheck();
    else if (path === '/api/stop') controller.stop();
    else if (path === '/api/continue') work = controller.resumeHelp();
    else if (path === '/api/resume') work = controller.resumeSafety(z.object({ acknowledgeSafety: z.literal(true) }).parse(data).acknowledgeSafety);
    else return json(res, 404, { error: 'Unknown command.' });
    // Let synchronous validation rejections settle; the long run continues through SSE.
    if (work) { let rejection: unknown; const tracked = work.catch(error => { rejection = error; }); await Promise.resolve(); if (rejection) throw rejection; void tracked; }
    return json(res, 202, state());
  } catch (error) {
    const message = error instanceof z.ZodError ? 'Check the submitted fields.' : error instanceof Error ? error.message.replace(/sk-[\w-]+/g, '[redacted]') : 'Request failed.';
    json(res, error instanceof Attention ? 409 : 400, { error: message });
  }
});
server.listen(config.PORT, '127.0.0.1', () => console.log(`TinkerCUA chat: http://127.0.0.1:${config.PORT}\nModel: ${config.OPENAI_MODEL} · new empty circuit builds`));
const heartbeat = setInterval(() => { for (const stream of clients) stream.write(': heartbeat\n\n'); }, 15000);
async function shutdown() { controller.stop(); browser.onClosed = undefined; clearInterval(heartbeat); for (const stream of clients) stream.end(); await browser.close(); await saving; server.close(); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
