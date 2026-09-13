import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, type AgentOptions } from '../src/agent.js';
import type { Executor } from '../src/browser.js';

const shot = { image: 'cG5n', width: 1280, height: 800, url: 'https://www.tinkercad.com/things/abc/editel', capturedAt: '2026-09-13T00:00:00Z' };
const report = { completed: ['Edited code'], verified: [], unverified: ['LED behavior'], needsAttention: false };
const response = (output: unknown[], id = 'resp_1') => ({ id, status: 'completed', output, output_text: '' });
const call = (actions: unknown[], checks: unknown[] = []) => ({ type: 'computer_call', call_id: 'call_1', actions, pending_safety_checks: checks });
test('request_help ends the run immediately with a concrete human action and no computer actions', async () => {
  const help = { reason: 'The value field will not open.', action: 'Open the resistor properties in Tinkercad, then click Continue.' };
  let calls = 0;
  const { agent, executed, shots } = setup(async req => { calls++; assert.ok(req.tools?.some(t => t.type === 'function' && t.name === 'request_help')); return response([{ type: 'function_call', name: 'request_help', call_id: 'help', arguments: JSON.stringify(help) }]); });
  await agent.start('Build LED'); assert.equal(agent.state.status, 'needs-attention'); assert.deepEqual(agent.state.helpRequest, help);
  assert.equal(agent.state.busy, false); assert.equal(calls, 1); assert.equal(shots(), 1); assert.equal(executed.length, 0);
});
function setup(create: AgentOptions['create'], extra: Partial<AgentOptions> = {}) {
  const executed: unknown[] = []; let shots = 0;
  const browser: Executor = { observe: async () => { shots++; return shot; }, execute: async a => { executed.push(a); } };
  const agent = new Agent({ create, browser, model: 'gpt-6-astra', maxActions: 5, maxTurns: 5, maxRuntimeMs: 5000, retryDelayMs: 1, ...extra });
  return { agent, executed, shots: () => shots };
}
test('computer calls return screenshots with original call IDs and conversation continuation', async () => {
  const requests: any[] = [];
  const { agent, shots } = setup(async req => { requests.push(req); return requests.length === 1 ? response([call([{ type: 'click', x: 10, y: 10, button: 'left' }])]) : response([{ type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]); });
  await agent.start('Make it blink twice as fast.');
  assert.equal(requests[0].model, 'gpt-6-astra');
  assert.equal(requests[1].previous_response_id, 'resp_1');
  assert.equal(requests[1].input[0].call_id, 'call_1');
  assert.equal(requests[1].input[0].output.type, 'computer_screenshot');
  assert.ok(shots() >= 2);
  assert.equal(agent.state.status, 'completed');
  assert.deepEqual(agent.state.result?.verified, []);
});
test('transient API failures have bounded retries and clear attention state', async () => {
  let attempts = 0;
  const { agent } = setup(async () => { attempts++; throw Object.assign(new Error('Unavailable'), { status: 503 }); });
  await agent.start('Inspect circuit');
  assert.equal(attempts, 3); assert.equal(agent.state.status, 'needs-attention');
});
test('authentication failure is not retried', async () => {
  let attempts = 0;
  const { agent } = setup(async () => { attempts++; throw Object.assign(new Error('Invalid key'), { status: 401 }); });
  await agent.start('Inspect circuit');
  assert.equal(attempts, 1); assert.equal(agent.state.status, 'failed');
});
test('repeated computer actions stop with a help request before a third attempt', async () => {
  const { agent, executed } = setup(async () => response([call([{ type: 'click', x: 10, y: 10, button: 'left' }])]));
  await agent.start('Edit resistor'); assert.equal(executed.length, 2);
  assert.match(agent.state.helpRequest?.reason || '', /repeated/); assert.ok(agent.state.helpRequest?.action);
});
test('safety checks pause before execution; resumption returns fresh observation and explicit acknowledgement', async () => {
  const requests: any[] = [];
  const { agent, executed, shots } = setup(async req => { requests.push(req); return requests.length === 1 ? response([call([{ type: 'wait' }], [{ id: 'check_1', message: 'Review this action' }])]) : response([{ type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]); });
  await agent.start('Inspect circuit');
  assert.equal(agent.state.status, 'needs-attention'); assert.equal(executed.length, 0);
  await assert.rejects(agent.resume(false), /review/i);
  const before = shots(); await agent.resume(true);
  assert.ok(shots() > before);
  assert.equal(requests[1].input[0].acknowledged_safety_checks[0].id, 'check_1');
  assert.equal(executed.length, 0);
});
test('one run at a time; stopping an in-flight model request prevents its actions', async () => {
  let release!: (r: any) => void;
  const { agent, executed } = setup(async () => new Promise(resolve => { release = resolve; }));
  const running = agent.start('Inspect circuit');
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(agent.start('Another run'), /active/i);
  agent.stop(); release(response([call([{ type: 'wait' }])])); await running;
  assert.equal(agent.state.status, 'stopped'); assert.equal(executed.length, 0);
});
test('runtime and action limits become attention states without replaying a build', async () => {
  const { agent, executed } = setup(async () => response([call(Array(6).fill({ type: 'wait' }))]));
  await agent.start('Inspect circuit');
  assert.equal(executed.length, 0); assert.equal(agent.state.status, 'needs-attention');
  const timed = setup(async (_req, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { maxRuntimeMs: 15 });
  await timed.agent.start('Inspect circuit');
  assert.equal(timed.agent.state.status, 'needs-attention');
});
test('Stop while writing the response artifact cannot become completed', async () => {
  let writing!: () => void; let release!: () => void;
  const reached = new Promise<void>(resolve => { writing = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { agent } = setup(async () => response([{ type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]), {
    artifact: async (_run, name) => { if (name === 'response-1.json') { writing(); await blocked; } },
  });
  const running = agent.start('Inspect circuit'); await reached;
  agent.stop(); release(); await running;
  assert.equal(agent.state.status, 'stopped');
});
test('new project requests do not inherit another circuit report', async () => {
  const requests: any[] = [];
  const { agent } = setup(async req => { requests.push(req);return response([{type:'function_call',name:'finish_report',call_id:'finish',arguments:JSON.stringify(report)}]); });
  await agent.start('Inspect first project');
  await agent.start('Inspect different project', false);
  assert.match(requests[1].input[0].content[0].text, /Previous report.*: null/);
});
test('observed milestone tool continues with matching function output and a fresh screenshot', async () => {
  const requests: any[] = []; const milestones: unknown[] = [];
  const { agent, shots } = setup(async req => { requests.push(req); return response([requests.length === 1 ? { type: 'function_call', name: 'report_progress', call_id: 'progress1', arguments: JSON.stringify({ phase: 'building', message: 'Arduino placed on canvas.' }) } : { type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]); }, { onMilestone: m => { milestones.push(m); } });
  await agent.start('Build LED');
  assert.equal(milestones.length, 1); assert.equal(requests[1].previous_response_id, 'resp_1');
  assert.equal(requests[1].input[0].type, 'function_call_output'); assert.equal(requests[1].input[0].call_id, 'progress1'); assert.equal(shots(), 2);
});
test('function progress continuation does not attach input_image with previous_response_id', async () => {
  const requests: any[] = [];
  const { agent } = setup(async req => { requests.push(req); return response([requests.length === 1 ? { type: 'function_call', name: 'report_progress', call_id: 'p', arguments: JSON.stringify({ phase: 'building', message: 'Arduino placed.' }) } : { type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]); });
  await agent.start('Build LED');
  assert.equal(requests[1].previous_response_id, 'resp_1');
  assert.equal(JSON.stringify(requests[1].input).includes('input_image'), false);
  assert.match(requests[1].input[0].output, /fresh screenshot/);
});
test('actual SDK connection errors are retried even though their Error.name is generic', async () => {
  const { APIConnectionError, APIConnectionTimeoutError } = await import('openai');
  for (const failure of [new APIConnectionError({ cause: new Error('socket closed') }), new APIConnectionTimeoutError()]) {
    let attempts = 0;
    const { agent, executed } = setup(async () => { attempts++; if (attempts < 3) throw failure; return response([{ type: 'function_call', name: 'finish_report', call_id: 'finish', arguments: JSON.stringify(report) }]); });
    await agent.start('Inspect circuit');
    assert.equal(attempts, 3); assert.equal(agent.state.status, 'completed'); assert.equal(executed.length, 0);
  }
});
