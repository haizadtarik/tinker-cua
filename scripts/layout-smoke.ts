import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const origin = process.env.TEST_ORIGIN || 'http://localhost:4317';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const directory = 'artifacts/layout-smoke';
await mkdir(directory, { recursive: true });
try {
  const context = await browser.newContext({ viewport: null });
  // Keep the real layout and assets, but never claim or change the user's session.
  await context.route('**/api/session', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This browser session belongs to another chat. Click New session to start fresh. Your Tinkercad login and existing circuits will be kept.' }) }));
  const page = await context.newPage(); await page.goto(origin); await page.locator('#error').waitFor({ state: 'visible' });
  const client = await context.newCDPSession(page);
  const { windowId } = await client.send('Browser.getWindowForTarget');
  for (const [width, height] of [[1280, 800], [1100, 760], [900, 650]]) {
    await client.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
    await page.waitForFunction(w => innerWidth === w, width);
    await check(`native-${width}`);
  }
  for (const [width, height] of [[1440, 850], [1024, 600], [768, 600], [390, 700], [320, 568]]) {
    await page.setViewportSize({ width, height }); await check(`viewport-${width}`);
  }
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.evaluate(() => {
    document.querySelector('#error')!.setAttribute('hidden', '');
    document.querySelector('#examples')!.setAttribute('hidden', '');
    document.querySelector('#help')!.removeAttribute('hidden');
    document.querySelector('#help-reason')!.textContent = 'The resistor value field is not accepting edits.';
    document.querySelector('#help-action')!.textContent = 'Select the resistor, set its value to 0.33 kΩ, press Enter, then click Continue.';
    document.querySelector('#conversation')!.textContent = 'Earlier circuit progress. '.repeat(500);
  });
  await check('help-desktop');
  await page.setViewportSize({ width: 390, height: 700 }); await check('help-mobile');
  async function check(name: string) {
    const layout = await page.evaluate(() => {
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, composer: document.querySelector('#composer')!.getBoundingClientRect().toJSON(), newSession: document.querySelector('#new-session')!.getBoundingClientRect().toJSON() };
    });
    await page.screenshot({ path: `${directory}/${name}.png` });
    assert.ok(layout.scrollWidth <= layout.width, `${name}: horizontal overflow ${JSON.stringify(layout)}`);
    assert.ok(layout.composer.bottom <= layout.height && layout.composer.top >= 0, `${name}: message box outside viewport ${JSON.stringify(layout)}`);
    assert.ok(layout.newSession.right <= layout.width && layout.newSession.bottom <= layout.height, `${name}: New session outside viewport`);
    assert.ok(layout.scrollHeight <= layout.height + 1, `${name}: page exceeds window height`);
    console.log(`PASS ${name}: ${layout.width} × ${layout.height}, message box and New session fit.`);
  }
} finally { await browser.close(); }
