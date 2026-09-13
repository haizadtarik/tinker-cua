import 'dotenv/config';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('artifacts/feasibility', { recursive: true });
const model = process.env.OPENAI_MODEL || 'gpt-6-astra';
const client = new OpenAI({ maxRetries: 0, timeout: 45000 });
try {
  const response = await client.responses.create({
    model, tools: [{ type: 'computer' }],
    input: 'Computer-use protocol feasibility check. Request a screenshot using the computer tool; do not perform any other action.',
    reasoning: { effort: 'low' }, max_output_tokens: 1000,
  });
  await writeFile('artifacts/feasibility/api.json', JSON.stringify(response, null, 2));
  console.log(JSON.stringify({ model, status: response.status, output: response.output }));
} catch (error) {
  const e = error as { status?: number; code?: string; message?: string };
  const result = { model, status: e.status, code: e.code, message: e.message?.replace(/sk-[\w-]+/g, '[redacted]') };
  await writeFile('artifacts/feasibility/api-error.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
if (process.argv.includes('--browser')) {
  const { BrowserExecutor } = await import('../src/browser.js');
  const browser = new BrowserExecutor(process.env.BROWSER_CHANNEL || 'chrome');
  await browser.open(new AbortController().signal);
  console.log('Dedicated browser opened. Complete login manually. This probe takes no login screenshots.');
  process.on('SIGINT', async () => { await browser.close(); process.exit(); });
}
