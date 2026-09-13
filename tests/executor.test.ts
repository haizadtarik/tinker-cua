import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeOnPage, blocksNavigation } from '../src/browser.js';
import type { Page } from 'playwright';
test('frame-unavailable popup navigation is blocked without throwing', () => {
  const request = { isNavigationRequest: () => true, frame: () => { throw new Error('Frame unavailable'); }, url: () => 'https://example.com' };
  assert.equal(blocksNavigation(request, 'abc'), true);
  assert.equal(blocksNavigation(request), false);
});

test('interrupted drag releases pointer and skips remaining motion', async () => {
  const c = new AbortController(); const moves: number[] = []; let ups = 0;
  const page = { mouse: { move: async (x: number) => { moves.push(x); if (x === 20) c.abort(); }, down: async () => {}, up: async () => { ups++; } }, keyboard: {} } as unknown as Page;
  await assert.rejects(executeOnPage(page, { type: 'drag', path: [{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }] }, c.signal));
  assert.deepEqual(moves, [10, 20]); assert.equal(ups, 1);
});
test('interrupted modifier keypress releases keys already held', async () => {
  const c = new AbortController(); const downs: string[] = []; const ups: string[] = [];
  const page = { keyboard: { down: async (k: string) => { downs.push(k); c.abort(); }, up: async (k: string) => { ups.push(k); } } } as unknown as Page;
  await assert.rejects(executeOnPage(page, { type: 'keypress', keys: ['CMD', 'A'] }, c.signal));
  assert.deepEqual(downs, ['Meta']); assert.deepEqual(ups, ['Meta']);
});
test('scope is checked between scroll pointer movement and wheel action', async () => {
  let navigated = false; let wheels = 0;
  const page = { mouse: { move: async () => { navigated = true; }, wheel: async () => { wheels++; } } } as unknown as Page;
  await assert.rejects(executeOnPage(page, { type: 'scroll', x: 10, y: 10, scroll_x: 0, scroll_y: 100 }, new AbortController().signal, () => { if (navigated) throw new Error('Outside project'); }));
  assert.equal(wheels, 0);
});
