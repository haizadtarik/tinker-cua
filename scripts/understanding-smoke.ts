import 'dotenv/config';
import OpenAI from 'openai';
import assert from 'node:assert/strict';
import { interpreter } from '../src/understanding.js';
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const understand = interpreter((body, signal) => client.responses.create(body, { signal }), process.env.OPENAI_MODEL || 'gpt-6-astra');
for (const [prompt, expected, history] of [
  ['Build an Arduino with an external LED blinking one second on, one second off.', 'supported', '[]'],
  ['Build a robot car with a motor controller and distance sensor.', 'unsupported', '[]'],
  ['Make it blink twice as fast.', 'supported', '[{"role":"user","text":"Build an Arduino with external LED, 1000ms on and off."}]'],
]) {
  const result = await understand(prompt, history, AbortSignal.timeout(60000));
  assert.equal(result.decision, expected); console.log(JSON.stringify(result));
}
console.log('PASS: live GPT-6 Astra request understanding accepts the LED build and follow-up, and rejects an unsupported motor/sensor circuit. No browser actions performed.');
