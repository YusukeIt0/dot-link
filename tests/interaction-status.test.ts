import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionStatus } from '../src/interaction-status.ts';

test('voice elapsed time continues through recognition and sending, and unrelated arrivals do not finish it', () => {
  let now = 1000;
  const state = new InteractionStatus(() => now);
  state.connection = 'online'; state.dotConnected = true;
  state.begin('voice', 'recognizing'); now += 2300;
  assert.equal(state.caption(''), '認識中 · 2秒');
  state.begin('voice', 'sending'); now += 900;
  state.waiting('voice'); state.complete('notification:other');
  assert.equal(state.caption(''), 'Dotの返信待ち · 3秒');
  assert.equal(state.ticking, true);
  now += 5000; state.complete('voice');
  assert.equal(state.caption('Dot · 1/2', 'voice'), 'Dot · 1/2 · 8.2秒');
  assert.equal(state.ticking, false);
  now += 5000; state.complete('voice');
  assert.equal(state.caption('Dot · 1/2', 'voice'), 'Dot · 1/2 · 8.2秒');
  assert.equal(state.caption('Dot · 2/2', 'historical'), 'Dot · 2/2');
});

test('disconnect has its own state, then resumes the observed wait without resetting its clock', () => {
  let now = 0;
  const state = new InteractionStatus(() => now);
  state.connection = 'online'; state.dotConnected = true;
  state.begin('text', 'sending'); state.waiting('text');
  now = 2000; state.connection = 'offline';
  assert.equal(state.caption(''), '切断 · 再接続中');
  assert.equal(state.ticking, false);
  now = 7000; state.connection = 'online';
  assert.equal(state.caption(''), 'Dotの返信待ち · 7秒');
  state.dotConnected = false;
  assert.equal(state.caption(''), 'Dot未接続');
  state.connection = 'unpaired'; assert.equal(state.caption(''), '接続設定が必要');
});

test('manual review time is excluded and an older reply cannot end a new recording or request', () => {
  let now = 0;
  const state = new InteractionStatus(() => now);
  state.connection = 'online'; state.dotConnected = true;
  state.begin('first', 'recognizing'); now = 1000; state.review();
  now = 61000; state.begin('first', 'sending'); now = 62000;
  assert.equal(state.caption(''), '送信中 · 2秒');
  state.waiting('first');
  state.setPhase('recording'); state.complete('first');
  assert.equal(state.caption(''), '録音中');
  state.begin('second', 'recognizing'); state.complete('first');
  assert.equal(state.caption(''), '認識中 · 0秒');
  now = 63000; state.complete('second');
  assert.equal(state.caption('Dot', 'second'), 'Dot · 1.0秒');
});
