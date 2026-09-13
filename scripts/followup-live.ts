import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = 'http://127.0.0.1:4317';
const saved = JSON.parse(await readFile('.session.json', 'utf8'));
const context = await chromium.launchPersistentContext(resolve('.chat-profile'), { channel: 'chrome', headless: false, viewport: null });
await context.addCookies([{ name: 'tinkercua_session', value: saved.owner, url: origin, httpOnly: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 31536000 }]);
const page = context.pages()[0] || await context.newPage();
await page.goto(origin);
await page.waitForFunction(() => !(document.querySelector('#prompt') as HTMLTextAreaElement).disabled);
await page.locator('#prompt').fill('Make it blink twice as fast.'); await page.locator('#send').click();
let previous = '';
const timer = setInterval(async () => {
  try {
    const state = await context.request.get(`${origin}/api/state`).then(r => r.json());
    const summary = JSON.stringify({ phase: state.phase, busy: state.busy, projectUrl: state.projectUrl, latest: state.messages.at(-1) });
    if (summary !== previous) { console.log(summary); previous = summary; await writeFile('artifacts/live-acceptance/followup.json', JSON.stringify(state, null, 2)); }
    if (!state.busy && ['completed', 'needs_input', 'failed'].includes(state.phase)) {
      await page.screenshot({ path: 'artifacts/live-acceptance/followup-report.png', fullPage: true }); clearInterval(timer); console.log('Follow-up stopped. Chat remains open for inspection.');
    }
  } catch (e) { console.log((e as Error).message.split('\n')[0]); }
}, 3000);
context.on('close', () => { clearInterval(timer); });
process.on('SIGINT', () => { clearInterval(timer); void context.close().then(() => process.exit()); });
