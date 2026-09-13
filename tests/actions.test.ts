import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, parseAction, mapKey, projectId } from '../src/actions.js';

test('coordinates and action shapes are validated before execution', () => {
  assert.throws(() => parseAction({ type: 'click', x: 1280, y: 0, button: 'left' }, 1280, 800));
  assert.throws(() => parseAction({ type: 'drag', path: [] }, 1280, 800));
  assert.throws(() => parseAction({ type: 'shell', command: 'anything' }, 1280, 800));
  assert.equal(parseAction({ type: 'click', x: 100, y: 50, button: 'left' }, 1280, 800).type, 'click');
});
test('maps editing keys and rejects browser navigation shortcuts', () => {
  assert.equal(mapKey('CMD'), 'Meta');
  assert.equal(mapKey('ARROWDOWN'), 'ArrowDown');
  assert.throws(() => parseAction({ type: 'keypress', keys: ['CTRL', 'L'] }, 1280, 800));
});
test('project scope excludes other sites and projects', () => {
  assert.equal(projectId('https://www.tinkercad.com/things/abc-demo/editel?foo=1'), 'abc');
  assert.equal(projectId('https://www.tinkercad.com/things/abc-demo'), null);
  assert.equal(projectId('https://www.tinkercad.com.evil.test/things/abc/editel'), null);
});
test('Stop prevents the remaining batch from executing', async () => {
  const abort = new AbortController(); const executed: string[] = [];
  await assert.rejects(executeBatch([{ type: 'wait' }, { type: 'screenshot' }], {
    signal: abort.signal, remaining: 5, width: 1280, height: 800,
    execute: async a => { executed.push(a.type); abort.abort(); },
  }));
  assert.deepEqual(executed, ['wait']);
});
test('invalid batches and over-budget batches execute nothing', async () => {
  let count = 0;
  await assert.rejects(executeBatch([{ type: 'wait' }, { type: 'bad' }], {
    signal: new AbortController().signal, remaining: 5, width: 1280, height: 800,
    execute: async () => { count++; },
  }));
  await assert.rejects(executeBatch([{ type: 'wait' }, { type: 'wait' }], {
    signal: new AbortController().signal, remaining: 1, width: 1280, height: 800,
    execute: async () => { count++; },
  }));
  assert.equal(count, 0);
});
