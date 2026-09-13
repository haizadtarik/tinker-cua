import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:4317';
const artifacts = process.env.TEST_ARTIFACT_DIR || 'artifacts/live-acceptance';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
if (process.argv.includes('--continue')) {
  const saved = JSON.parse(await readFile(process.env.TEST_SESSION_FILE || '.session.json', 'utf8'));
  await context.addCookies([{ name: 'tinkercua_session', value: saved.owner, url: origin, httpOnly: true, sameSite: 'Strict' }]);
}
const page = await context.newPage();
await page.goto(origin); await page.locator('#prompt').waitFor({ state: 'visible' });
await page.waitForFunction(() => !(document.querySelector('#prompt') as HTMLTextAreaElement).disabled);
await page.locator('#prompt').fill(process.argv.includes('--continue') ? 'Continue building the Arduino with an external LED blinking one second on, one second off in this existing empty project. Inspect first and avoid duplicate parts.' : 'Build an Arduino with an external LED blinking one second on, one second off.');
await page.locator('#send').click();
await mkdir(artifacts, { recursive: true });
let last = ''; let followup = false;
const timer = setInterval(async () => {
  try {
    const state = await context.request.get(`${origin}/api/state`).then(r => r.json());
    const text = JSON.stringify({ phase: state.phase, busy: state.busy, projectUrl: state.projectUrl, latest: state.messages?.at(-1) });
    if (text !== last) { console.log(text); last = text; await writeFile(`${artifacts}/latest.json`, JSON.stringify(state, null, 2)); }
    if (state.phase === 'completed' && !state.busy && !followup) {
      followup = true;
      await page.screenshot({ path: `${artifacts}/first-report.png`, fullPage: true });
      await page.locator('#prompt').fill('Make it blink twice as fast.'); await page.locator('#send').click();
    }
    if (state.phase === 'completed' && !state.busy && followup && state.messages.filter((m: any) => m.role === 'user').at(-1)?.text === 'Make it blink twice as fast.') {
      await page.screenshot({ path: `${artifacts}/followup-report.png`, fullPage: true }); clearInterval(timer); console.log('Both run reports are available. Inspect evidence before claiming acceptance. Chat stays open.');
    }
  } catch (e) { console.log((e as Error).message.split('\n')[0]); }
}, 3000);
process.on('SIGINT', () => { clearInterval(timer); void browser.close().then(() => process.exit()); });
