import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ownership } from '../src/ownership.js';
test('only the owning conversation cookie can access the managed browser session', () => {
  const owner = new Ownership(); assert.equal(owner.owns(), false);
  const cookie = owner.connect(); assert.match(cookie, /Max-Age=31536000/); assert.equal(owner.owns(cookie), true);
  assert.equal(owner.owns('tinkercua_session=another'), false);
  assert.throws(() => owner.connect(), /another chat/);
  assert.throws(() => owner.connect('tinkercua_session=another'), /another chat/);
  assert.equal(owner.connect(cookie), cookie);
});
test('new session rotates ownership and both capabilities, invalidating the old chat', () => {
  const owner = new Ownership(); const oldCookie = owner.connect(); const oldToken = owner.token; const resetToken = owner.resetToken;
  const cookie = owner.newSession(resetToken);
  assert.equal(owner.owns(cookie), true); assert.equal(owner.owns(oldCookie), false);
  assert.notEqual(owner.token, oldToken); assert.notEqual(owner.resetToken, resetToken);
  assert.throws(() => owner.newSession(resetToken), /Refresh/);
});
