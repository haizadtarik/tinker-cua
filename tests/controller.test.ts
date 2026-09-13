import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.js';
import { Agent } from '../src/agent.js';
const url = 'https://www.tinkercad.com/things/abc/editel';
function fixture(auth = false) {
  const counts = { open: 0, check: 0, prepare: 0, shots: 0, actions: 0 };
  const browser = { isOpen: false, projectUrl: undefined as string | undefined, pauseForLogin() {}, pause() {},
    reset() { this.projectUrl = undefined; },
    async open() { counts.open++; this.isOpen = true; },
    async authenticated() { counts.check++; return auth; },
    async prepare() { counts.prepare++; this.projectUrl = url; },
    async observe() { counts.shots++; if (!this.isOpen) throw new Error('Browser closed'); return { image: 'cG5n', width: 1280, height: 800, url, capturedAt: '' }; },
    async execute() { counts.actions++; },
  };
  const agent = new Agent({ browser, model: 'gpt-6-astra', maxActions: 10, maxTurns: 10, maxRuntimeMs: 5000,
    create: async () => ({ id: 'resp', status: 'completed', output_text: '', output: [{ type: 'function_call', id: 'f', call_id: 'f', name: 'finish_report', arguments: JSON.stringify({ completed: ['Code added'], verified: ['Delays inspected'], unverified: ['Blinking'], needsAttention: false }) }] }),
  });
  const controller = new Controller({ browser, agent, understand: async (prompt) => ({ decision: prompt.includes('motor') ? 'unsupported' : 'supported', message: 'I’ll build an Arduino and external LED.', task: prompt }), onChange() {} });
  return { controller, browser, agent, counts, login: () => { auth = true; } };
}
test('login handoff takes no screenshots; early login click remains paused; successful check continues', async () => {
  const f = fixture(); await f.controller.message('Build a blinking LED', '1');
  assert.equal(f.controller.state.phase, 'awaiting_login'); assert.equal(f.counts.shots, 0);
  await f.controller.loginCheck(); assert.equal(f.controller.state.phase, 'awaiting_login'); assert.equal(f.counts.shots, 0);
  f.login(); await f.controller.loginCheck(); assert.equal(f.counts.shots, 1); assert.equal(f.controller.state.projectUrl, url);
});
test('new session clears chat/project and request history while retaining the open browser', async () => {
  const f = fixture(true); await f.controller.message('Build LED', 'same-id');
  const old = structuredClone(f.controller.snapshot()); f.controller.newSession();
  assert.notEqual(f.controller.state.id, old.state.id); assert.equal(f.controller.state.projectUrl, undefined);
  assert.equal(f.controller.state.messages.length, 1); assert.equal(f.browser.isOpen, true);
  await f.controller.message('Build another LED', 'same-id'); assert.equal(f.counts.prepare, 2);
});
test('new session cannot overlap a running request, even immediately after Stop', async () => {
  const f = fixture(); let release!: (value: any) => void;
  const c = new Controller({ browser: f.browser, agent: f.agent, understand: async () => new Promise(r => { release = r; }), onChange() {} });
  const running = c.message('Build LED', 'a'); const id = c.state.id;
  assert.throws(() => c.newSession(), /active/); c.stop(); assert.throws(() => c.newSession(), /active/);
  release({ decision: 'supported', message: 'Ready', task: 'Build LED' }); await running;
  assert.equal(c.state.id, id); c.newSession(); assert.notEqual(c.state.id, id);
});
test('help pauses the controller and Continue inspects the same screen with the original task', async () => {
  const f = fixture(true); let requests = 0; let lastRequest: any;
  const help = { reason: 'The resistor value field is not accepting edits.', action: 'Set the resistor to 330 ohms in Tinkercad, then click Continue.' };
  const agent = new Agent({ browser: f.browser, model: 'gpt-6-astra', maxActions: 10, maxTurns: 1, maxRuntimeMs: 5000,
    create: async req => { lastRequest = req; return { id: 'r', status: 'completed', output_text: '', output: [{ type: 'function_call', id: 'f', call_id: 'f', name: ++requests === 1 ? 'request_help' : 'finish_report', arguments: JSON.stringify(requests === 1 ? help : { completed: [], verified: [], unverified: [], needsAttention: false }) }] }; },
  });
  const c = new Controller({ browser: f.browser, agent, understand: async prompt => ({ decision: 'supported', message: 'Ready', task: prompt }), onChange() {} });
  await c.message('Build LED with 1000 ms delays', 'a');
  assert.deepEqual(c.state.helpRequest, help); assert.equal(c.state.busy, false); assert.equal(f.counts.actions, 0);
  const before = f.counts.shots; const checks = f.counts.check;
  let preserve: boolean | undefined; f.browser.prepare = async (_signal?: AbortSignal, keep?: boolean) => { preserve = keep; };
  await c.resumeHelp(); assert.equal(preserve, true); assert.equal(f.counts.check, checks);
  assert.ok(f.counts.shots > before); assert.equal(c.state.projectUrl, url); assert.equal(c.state.helpRequest, undefined);
  assert.match(JSON.stringify(lastRequest.input), /1000 ms/); assert.equal(c.state.phase, 'completed');
  await assert.rejects(c.resumeHelp(), /no help/i);
});
test('already authenticated builds directly; follow-up keeps the project; request retry is idempotent', async () => {
  const f = fixture(true); await f.controller.message('Build a blinking LED', '1');
  await f.controller.message('Build a blinking LED', '1'); assert.equal(f.counts.prepare, 1);
  await f.controller.message('Make it blink twice as fast', '2'); assert.equal(f.controller.state.projectUrl, url);
  assert.equal(f.counts.shots, 2); assert.equal(f.controller.state.messages.filter(m => m.role === 'user').length, 2);
});
test('unsupported requests never open the browser', async () => {
  const f = fixture(); await f.controller.message('Build a motor controller', '1');
  assert.equal(f.counts.open, 0); assert.equal(f.controller.state.phase, 'needs_input');
});
test('Stop during understanding prevents launch and rejects concurrent submissions', async () => {
  const f = fixture(); let release!: (value: any) => void;
  const c = new Controller({ browser: f.browser, agent: f.agent, understand: async () => new Promise(r => { release = r; }), onChange() {} });
  const running = c.message('Build LED', 'a');
  await assert.rejects(c.message('Another', 'b'), /active/);
  c.stop(); release({ decision: 'supported', message: 'Ready', task: 'Build LED' }); await running;
  assert.equal(c.state.phase, 'stopped'); assert.equal(f.counts.open, 0);
});
test('closed browser run becomes recoverable and cannot report completion', async () => {
  const f = fixture(true); f.browser.prepare = async () => { f.browser.isOpen = false; throw new Error('Browser closed. Send your instruction again to reopen it.'); };
  await f.controller.message('Build LED', '1'); assert.equal(f.controller.state.phase, 'failed'); assert.match(f.controller.state.messages.at(-1)!.text, /closed/);
});
test('a browser preparation failure asks for help and can be retried with Continue', async () => {
  const f = fixture(true); const prepare = f.browser.prepare;
  f.browser.prepare = async () => { throw new Error('Tinkercad did not finish loading.'); };
  await f.controller.message('Build LED', 'load');
  assert.match(f.controller.state.helpRequest?.reason || '', /loading/);
  f.browser.prepare = prepare; await f.controller.resumeHelp();
  assert.equal(f.controller.state.phase, 'completed'); assert.equal(f.controller.state.helpRequest, undefined);
});
test('an incomplete report keeps its completed work and evidence alongside the help request', async () => {
  const f = fixture(true);
  f.agent.state.result = { completed: ['Placed Arduino'], verified: ['D8 code inspected'], unverified: ['LED not lighting'], needsAttention: true };
  f.agent.start = async () => { f.agent.state.status = 'needs-attention'; f.agent.state.helpRequest = { reason: 'LED not lighting', action: 'Check the LED connection.' }; };
  await f.controller.message('Build LED', 'partial');
  assert.deepEqual(f.controller.state.messages.at(-1)?.result?.verified, ['D8 code inspected']);
  assert.deepEqual(f.controller.state.messages.at(-1)?.result?.completed, ['Placed Arduino']);
  assert.equal(f.controller.state.helpRequest?.reason, 'LED not lighting');
});
test('saved conversation restores project/history and requires a fresh request after interruption', async () => {
  const f = fixture(true); await f.controller.message('Build LED', 'saved-request');
  const snapshot = f.controller.snapshot(); snapshot.state.busy = true; snapshot.state.phase = 'building';
  const next = fixture(true); next.controller.restore(snapshot);
  assert.equal(next.controller.state.busy, false); assert.equal(next.controller.state.phase, 'stopped');
  assert.equal(next.browser.projectUrl, url); assert.equal(next.counts.shots, 0);
  await next.controller.message('Build LED', 'saved-request'); assert.equal(next.counts.open, 0);
  await next.controller.message('Continue', 'new-request'); assert.equal(next.controller.state.projectUrl, url);
});
test('browser closing during an active loop ends in a recoverable state', async () => {
  const f = fixture(true); let release!: (r: any) => void;
  f.browser.observe = async () => new Promise(resolve => { release = resolve; });
  const run = f.controller.message('Build LED', 'close-test');
  while (!release) await new Promise(r => setTimeout(r, 1));
  f.browser.isOpen = false; f.controller.browserClosed();
  release({ image: '', width: 1280, height: 800, url, capturedAt: '' }); await run;
  assert.equal(f.controller.state.phase, 'needs_input'); assert.equal(f.controller.state.busy, false);
});
test('restoring a login handoff allows a new request to reopen the browser', async () => {
  const f = fixture(); await f.controller.message('Build LED', 'before-restart');
  const next = fixture(); next.controller.restore(f.controller.snapshot());
  assert.equal(next.controller.state.phase, 'stopped');
  await next.controller.message('Continue', 'after-restart');
  assert.equal(next.counts.open, 1); assert.equal(next.controller.state.phase, 'awaiting_login');
});
