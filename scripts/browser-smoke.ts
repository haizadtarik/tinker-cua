import 'dotenv/config';
import { chromium } from 'playwright';
import OpenAI from 'openai';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { executeOnPage } from '../src/browser.js';
import { executeBatch, parseAction } from '../src/actions.js';
import type { ResponseInput } from 'openai/resources/responses/responses';

await mkdir('artifacts/browser-smoke', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 2 });
  await page.setContent(`<html><body style="font:24px system-ui;padding:60px;background:#f2f6fa"><h1>TinkerCUA executor test</h1><p>This is a local test fixture, not Tinkercad.</p><button style="font:24px system-ui;padding:20px" onclick="this.textContent='Action verified'">Verify browser action</button><br><textarea style="margin-top:30px;width:600px;height:180px;font:18px monospace"></textarea><div id="drag" style="margin-top:10px;background:teal;width:100px;height:50px" onpointerdown="this.dataset.down='yes'" onpointerup="this.dataset.up='yes'">Drag test</div></body></html>`);
  const signal = new AbortController().signal;
  const box = await page.locator('textarea').boundingBox(); assert.ok(box);
  await executeOnPage(page, parseAction({ type: 'click', x: box.x + 20, y: box.y + 20, button: 'left' }, 960, 700), signal);
  await executeOnPage(page, { type: 'type', text: 'old code' }, signal);
  await executeOnPage(page, { type: 'keypress', keys: ['CMD', 'A'] }, signal);
  const sketch = 'void setup() {}\nvoid loop() { delay(500); }';
  await executeOnPage(page, { type: 'type', text: sketch }, signal);
  assert.equal(await page.locator('textarea').inputValue(), sketch);
  const d = await page.locator('#drag').boundingBox(); assert.ok(d);
  await executeOnPage(page, { type: 'drag', path: [{ x: d.x+10, y: d.y+10 }, { x: d.x+40, y: d.y+20 }] }, signal);
  assert.equal(await page.locator('#drag').getAttribute('data-up'), 'yes');
  await page.locator('#drag').evaluate(el => { delete (el as HTMLElement).dataset.up; });
  const stopping = new AbortController(); const started: string[] = [];
  const stopTimer = setTimeout(() => stopping.abort(new Error('Stop fixture')), 100);
  try {
    await assert.rejects(executeBatch([
      { type: 'drag', path: Array.from({ length: 20 }, (_, i) => ({ x: d.x + 10 + i * 3, y: d.y + 15 })) },
      { type: 'type', text: 'This action must never start' },
    ], { signal: stopping.signal, width: 960, height: 700, remaining: 2, execute: async action => { started.push(action.type); await executeOnPage(page, action, stopping.signal); } }));
  } finally { clearTimeout(stopTimer); }
  assert.deepEqual(started, ['drag']);
  assert.equal(await page.locator('#drag').getAttribute('data-up'), 'yes');
  console.log('PASS: Stop during a real Chrome drag releases the pointer and prevents the next batch action.');
  let screenshot = await page.screenshot({ scale: 'css' });
  assert.equal(screenshot.readUInt32BE(16), 960); assert.equal(screenshot.readUInt32BE(20), 700);
  console.log('PASS: real Chrome multiline editing, CMD+A, pointer drag, and CSS screenshot size at device scale 2. Local fixture only.');
  if (process.argv.includes('--model')) {
    const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
    const model = process.env.OPENAI_MODEL || 'gpt-6-astra';
    let previous: string | undefined;
    let input: ResponseInput = [{ role: 'user', content: [{ type: 'input_text', text: 'This is a local browser protocol test fixture. Click the button labeled Verify browser action using the computer tool. After observing Action verified, report that text and stop. Do not edit the textarea or navigate. Screenshot coordinates are 960x700 CSS pixels.' }, { type: 'input_image', image_url: `data:image/png;base64,${screenshot.toString('base64')}`, detail: 'original' }] }];
    let count = 0;
    for (let turn = 1; turn <= 5; turn++) {
      const response = await client.responses.create({ model, tools: [{ type: 'computer' }], reasoning: { effort: 'low' }, input, previous_response_id: previous, max_output_tokens: 1800 });
      await writeFile(`artifacts/browser-smoke/response-${turn}.json`, JSON.stringify(response, null, 2));
      console.log('Model turn', turn, response.output.map(o => o.type).join(', '));
      const calls = response.output.filter(o => o.type === 'computer_call');
      if (!calls.length) break;
      input = []; previous = response.id;
      for (const call of calls) {
        assert.equal(call.pending_safety_checks?.length || 0, 0);
        assert.ok(call.actions);
        await executeBatch(call.actions, { signal, width: 960, height: 700, remaining: 15-count, execute: async action => { count++; await executeOnPage(page, action, signal); } });
        screenshot = await page.screenshot({ scale: 'css' });
        const output = { type: 'computer_screenshot' as const, image_url: `data:image/png;base64,${screenshot.toString('base64')}`, detail: 'original' as const };
        input.push({ type: 'computer_call_output', call_id: call.call_id, output });
      }
    }
    assert.equal(await page.locator('button').textContent(), 'Action verified');
    console.log(`PASS: ${model} selected and executed a browser action, followed by screenshot continuation. Local fixture only.`);
  }
  await page.screenshot({ path: 'artifacts/browser-smoke/final.png', scale: 'css' });
} finally { await browser.close(); }
