import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = process.env.CHAT_ORIGIN || 'http://127.0.0.1:4317';
const address = new URL(origin);
if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(address.hostname) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('The saved chat can only be opened on a local HTTP backend.');
const sessionFile = process.env.SESSION_FILE || '.session.json';
const context = await chromium.launchPersistentContext(resolve('.chat-profile'), { channel: 'chrome', headless: false, viewport: null });
try {
  // Explicit local CLI recovery restores the saved conversation's owner cookie.
  // No token or account credential is put in a URL or printed.
  try {
    const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
    if (saved.owner) await context.addCookies([{ name: 'tinkercua_session', value: saved.owner, url: origin, httpOnly: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 31536000 }]);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const page = context.pages()[0] || await context.newPage();
  await page.goto(origin);
  console.log(`TinkerCUA chat: ${origin}`);
  if (process.argv.includes('--inspect')) {
    await page.waitForFunction(() => !(document.querySelector('#prompt') as HTMLTextAreaElement).disabled);
    await page.locator('#prompt').fill('Inspect the saved circuit without changing any components, wires, or timing values. Run the simulation and verify the external LED.');
    await page.locator('#send').click();
  }
} catch (error) { await context.close(); throw error; }
process.on('SIGINT', () => { void context.close().then(() => process.exit()); });
