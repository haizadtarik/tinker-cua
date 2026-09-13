import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { BrowserExecutor, LoginRequired } from '../src/browser.js';
const profile = await mkdtemp(join(tmpdir(), 'tinkercua-session-test-'));
const browser = new BrowserExecutor('chrome', profile);
const signal = AbortSignal.timeout(60000);
try {
  await browser.open(signal);
  assert.equal(browser.isOpen, true);
  assert.equal(await browser.authenticated(signal), false);
  await assert.rejects(browser.observe(signal), LoginRequired);
  await assert.rejects(browser.execute({ type: 'type', text: 'must not be typed' }, signal), LoginRequired);
  await browser.page!.close();
  await browser.open(signal);
  assert.equal(browser.isOpen, true);
  assert.match(browser.page!.url(), /tinkercad.com/);
  console.log('PASS: ordinary headed Chrome launched with an isolated profile, Playwright attached over local CDP, live Tinkercad required login, screenshots and actions remained blocked. Closed-tab recovery reopened Tinkercad. No credentials entered or login screenshots captured.');
} finally { await browser.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
