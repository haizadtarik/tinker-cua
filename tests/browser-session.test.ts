import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserExecutor, dashboardProjectId, LoginRequired } from '../src/browser.js';
test('dashboard cards identify existing projects without requiring editor URLs', () => {
  assert.equal(dashboardProjectId('https://www.tinkercad.com/things/abc-my-circuit'), 'abc');
  assert.equal(dashboardProjectId('https://www.tinkercad.com/things/abc/editel'), 'abc');
  assert.equal(dashboardProjectId('https://other.example/things/abc/editel'), undefined);
});
test('visible login overlay blocks observation AND actions before either reaches Playwright', async () => {
  const browser = new BrowserExecutor(); let shots = 0; let typed = 0;
  const b = browser as any;
  browser.projectUrl = 'https://www.tinkercad.com/things/abc/editel'; b.active = true;
  b.context = {}; b.page = { isClosed: () => false, url: () => browser.projectUrl,
    locator: (selector: string) => { assert.match(selector, /:visible/); return { count: async () => 1 }; },
    screenshot: async () => { shots++; }, keyboard: { insertText: async () => { typed++; } },
  };
  const signal = new AbortController().signal;
  await assert.rejects(browser.execute({ type: 'type', text: 'code' }, signal), LoginRequired);
  b.active = true;
  await assert.rejects(browser.observe(signal), LoginRequired);
  assert.equal(shots, 0); assert.equal(typed, 0);
});
test('Stop preserves a newly created editor before the next screenshot', () => {
  const browser = new BrowserExecutor(); const b = browser as any;
  b.creation = true; b.active = true;
  b.page = { url: () => 'https://www.tinkercad.com/things/new123/editel' };
  browser.pause(); assert.equal(browser.projectUrl, 'https://www.tinkercad.com/things/new123/editel');
});
test('existing dashboard project is not adopted during first-build creation', () => {
  const browser = new BrowserExecutor(); const b = browser as any;
  b.creation = true; b.priorProjects = new Set(['abc']);
  b.page = { url: () => 'https://www.tinkercad.com/things/abc/editel' };
  browser.pause(); assert.equal(browser.projectUrl, undefined);
});
test('closed tab in surviving context is replaced with a sized Tinkercad dashboard page', async () => {
  const browser = new BrowserExecutor(); const b = browser as any; const calls: string[] = [];
  let url = 'about:blank';
  const page = { isClosed: () => false, url: () => url, setViewportSize: async () => { calls.push('viewport'); }, goto: async (to: string) => { url = to; calls.push('navigate'); }, bringToFront: async () => { calls.push('front'); } };
  b.context = { pages: () => [], newPage: async () => page };
  b.page = { isClosed: () => true };
  await browser.open(new AbortController().signal);
  assert.deepEqual(calls, ['viewport', 'navigate', 'front']); assert.match(url, /tinkercad.com\/dashboard/);
});
test('a login overlay appearing during capture prevents the screenshot from being returned', async () => {
  const browser = new BrowserExecutor(); const b = browser as any; let loginVisible = false;
  browser.projectUrl = 'https://www.tinkercad.com/things/abc/editel'; b.active = true; b.context = {};
  b.page = { isClosed: () => false, url: () => browser.projectUrl,
    locator: () => ({ count: async () => loginVisible ? 1 : 0 }),
    screenshot: async () => { loginVisible = true; return Buffer.from('sensitive login image'); },
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  await assert.rejects(browser.observe(new AbortController().signal), LoginRequired);
});
test('Continue preserves the current editor screen but still blocks a visible login overlay', async () => {
  const browser = new BrowserExecutor(); const b = browser as any; let login = false; let navigations = 0;
  browser.projectUrl = 'https://www.tinkercad.com/things/abc/editel'; b.context = {};
  b.page = { isClosed: () => false, url: () => browser.projectUrl, locator: () => ({ count: async () => login ? 1 : 0 }), goto: async () => { navigations++; }, bringToFront: async () => {} };
  await browser.prepare(new AbortController().signal, true); assert.equal(navigations, 0);
  browser.pause(); login = true;
  await assert.rejects(browser.prepare(new AbortController().signal, true), LoginRequired); assert.equal(navigations, 0);
});
test('reset does not re-adopt the previous editor on pause and retains the browser context', () => {
  const browser = new BrowserExecutor(); const b = browser as any; const context = {};
  b.context = context; b.creation = true; b.active = true;
  b.page = { isClosed: () => false, url: () => 'https://www.tinkercad.com/things/old123/editel' };
  browser.reset(); browser.pause(); assert.equal(browser.projectUrl, undefined); assert.equal(browser.context, context); assert.equal(browser.isOpen, true);
});
