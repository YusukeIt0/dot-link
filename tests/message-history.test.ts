import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHistory, NewReplyQueue, type HistoryMessage } from '../src/message-history.ts';
const old: HistoryMessage = { id: 'location-old', status: 'replied', reply: 'Saved place recommendation', location_sharing_id: 'old-session', location_expires_at: '2026-10-12T08:00:00Z' };
const speech: HistoryMessage = { id: 'speech', status: 'replied', reply: 'A reply' };

test('cold restart restores expired location history without a new alert', () => {
  const result = reconcileHistory([], [old], true, () => false);
  assert.deepEqual(result.messages, [old]);
  assert.deepEqual(result.replies, []);
  assert.equal(result.displayId, old.id); // user opened the app: readable history
});
test('late expired, OFF or old-session announcements stay readable without waking or replacing display', () => {
  for (const reason of ['expired', 'off', 'previous session']) {
    const result = reconcileHistory([speech], [speech, old], false, () => false);
    assert.deepEqual(result.messages, [speech, old], reason);
    assert.deepEqual(result.replies, [], reason);
    assert.equal(result.displayId, undefined, reason);
  }
});
test('ordinary reply is displayed even when a later history item is a suppressed location announcement', () => {
  const pending = { ...speech, reply: undefined, status: 'accepted' };
  const result = reconcileHistory([pending], [speech, old], false, m => !m.location_sharing_id);
  assert.deepEqual(result.replies, [speech]);
  assert.equal(result.displayId, speech.id);
});
test('fresh eligible announcement alerts once; unchanged reconnect does not replay history', () => {
  const first = reconcileHistory([], [old], false, () => true);
  assert.deepEqual(first.replies, [old]);
  assert.equal(first.displayId, old.id);
  const reconnect = reconcileHistory(first.messages, [old], false, () => true);
  assert.deepEqual(reconnect.replies, []);
  assert.equal(reconnect.displayId, undefined);
});
test('initial restoration never announces old ordinary replies either', () => {
  const result = reconcileHistory([], [speech, old], true, () => true);
  assert.deepEqual(result.messages, [speech, old]);
  assert.deepEqual(result.replies, []);
});

test('reply arrival order wins over question creation order; receipt updates are not new replies', () => {
  const earlyQuestion: HistoryMessage = {id:'early',status:'accepted',createdAt:'2026-10-12T12:00:00Z'};
  const laterQuestion = {id:'later',status:'accepted',createdAt:'2026-10-12T12:00:10Z'};
  const laterReply = {...laterQuestion,reply:'Answered first',repliedAt:'2026-10-12T12:00:20Z'};
  const earlyReply = {...earlyQuestion,reply:'Answered second',repliedAt:'2026-10-12T12:00:30Z'};
  const result = reconcileHistory([earlyQuestion,laterQuestion],[earlyReply,laterReply],false,()=>true);
  assert.deepEqual(result.messages.map(m=>m.id),['later','early']);
  assert.equal(result.displayId,'later');
  const receipt = reconcileHistory([earlyQuestion],[{...earlyQuestion,readAt:'2026-10-12T12:00:15Z'}],false,()=>true);
  assert.deepEqual(receipt.replies,[]); assert.equal(receipt.displayId,undefined);
});

test('new replies queue while reading, survive metadata refresh, and do not jump past history', () => {
  const queue = new NewReplyQueue();
  const first = {...speech,id:'first'}, second = {...speech,id:'second'};
  queue.receive([first,second]); queue.receive([first]);
  assert.equal(queue.count,2);
  const options = {hidden:false,browsingHistory:false,mayAnnounce:()=>true};
  assert.equal(queue.next([first,second],undefined,options),'first');
  queue.seen('first');
  assert.equal(queue.next([first,second],first,options),undefined);
  assert.equal(queue.count,1);
  assert.equal(queue.next([first,second],first,{...options,hidden:true}),'second');
  assert.equal(queue.next([first,second],first,{...options,hidden:true,browsingHistory:true}),undefined);
  queue.seen('second'); assert.equal(queue.count,0);
});
