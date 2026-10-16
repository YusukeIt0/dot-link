import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationState, type ConversationMessage } from '../src/conversation-state.ts';
const message = (id: string, time: number, reply?: string): ConversationMessage => ({id, text: id,
  status: reply ? 'replied' : 'accepted', createdAt: new Date(time).toISOString(),
  ...(reply ? {reply, repliedAt: new Date(time).toISOString()} : {})});
const allowed = {allowed: true, hidden: false, mayAnnounce: () => true};
function show(state: ConversationState) { const selected = state.selectedForDisplay(); state.present(selected?.id); return selected; }

test('restored history is readable without announcements, including expired location replies', () => {
  const state = new ConversationState();
  const old = {...message('old', 1000, 'reply'), kind: 'proactive' as const, location_sharing_id: 'expired'};
  assert.deepEqual(state.receive([old], true, () => false), {announcements: [], waiting: undefined});
  assert.deepEqual(state.flush({...allowed, mayAnnounce: () => false}), {display: true, wake: false});
  assert.equal(show(state)?.id, 'old'); assert.equal(state.unreadCount, 0);
});

test('reply received during recording waits for display eligibility and is announced only once', () => {
  const state = new ConversationState();
  const pending = message('a', 1000); const reply = message('a', 2000, 'answer');
  assert.equal(state.receive([pending], true, () => true).waiting?.id, 'a');
  state.flush(allowed); show(state);
  assert.deepEqual(state.receive([reply], false, () => true).announcements, [reply]);
  assert.deepEqual(state.flush({...allowed, allowed: false}), {display: false, wake: false});
  assert.equal(state.hasPendingDisplay, true); assert.equal(state.unreadCount, 1);
  assert.deepEqual(state.receive([{...reply, readAt: new Date(3000).toISOString()}], false, () => true).announcements, []);
  assert.deepEqual(state.flush(allowed), {display: true, wake: true});
  show(state); assert.equal(state.unreadCount, 0);
  assert.deepEqual(state.flush(allowed), {display: false, wake: false});
});

test('history browsing preserves selected identity across late reply sorting and unread arrivals', () => {
  const state = new ConversationState();
  const a = message('a', 1000, 'a'), b = message('b', 2000, 'b');
  state.receive([a,b], true, () => true); state.flush(allowed); show(state);
  state.navigate(-1); show(state);
  const lateA = message('a', 4000, 'a'), c = message('c', 3000, 'c');
  assert.deepEqual(state.receive([lateA,b,c], false, () => true).announcements, [c]);
  assert.equal(state.selected?.id, 'a'); assert.equal(state.position('a'), 3);
  assert.deepEqual(state.flush({...allowed, hidden: true}), {display: false, wake: true});
  assert.equal(state.visibleId, 'a'); assert.equal(state.unreadCount, 1);
});

test('visible reply is not replaced until standby allows a new arrival', () => {
  const state = new ConversationState(); const a=message('a',1000,'a'), b=message('b',2000,'b');
  state.receive([a],true,()=>true); state.flush(allowed); show(state);
  state.receive([a,b],false,()=>true);
  assert.deepEqual(state.flush(allowed),{display:false,wake:true});
  assert.equal(state.visibleId,'a'); assert.equal(state.unreadCount,1);
  state.receive([a,b],false,()=>true);
  assert.deepEqual(state.flush({...allowed,hidden:true}),{display:true,wake:false});
  assert.equal(show(state)?.id,'b'); assert.equal(state.unreadCount,0);
});

test('location eligibility is checked again at display time without losing durable history', () => {
  const state=new ConversationState(); const a=message('a',1000,'location');
  state.receive([a],false,()=>true);
  assert.deepEqual(state.flush({...allowed,mayAnnounce:()=>false}),{display:false,wake:true});
  assert.equal(state.find('a')?.reply,'location');
  state.receive([],false,()=>false); assert.equal(state.unreadCount,0);
});

test('send acknowledgement cannot overwrite an already received reply', () => {
  const state=new ConversationState(); const reply=message('a',2000,'answer');
  state.receive([reply],false,()=>true);
  assert.equal(state.acceptSent(message('a',1000)).reply,'answer');
  assert.equal(show(state)?.id,'a'); assert.equal(state.unreadCount,0);
});

test('presentation of transient status retains history selection for later repaint', () => {
  const state=new ConversationState(); state.receive([message('a',1000,'a')],true,()=>true);
  state.flush(allowed); show(state); state.present();
  assert.equal(state.visibleId,undefined); assert.equal(state.selected?.id,'a');
  assert.equal(show(state)?.id,'a');
});

test('forget clears history, unread and pending display using the existing transition policy', () => {
  const state=new ConversationState(); state.receive([message('a',1000,'a')],false,()=>true);
  state.forget(); assert.equal(state.selected,undefined); assert.equal(state.count,0);
  assert.equal(state.unreadCount,0); assert.equal(state.hasPendingDisplay,false);
});


test('announcement deduplication remains separate from unread eligibility after disappearance', () => {
  const state = new ConversationState(); const a = message('a', 1000, 'a');
  assert.equal(state.receive([a,a], false, () => true).announcements.length, 1);
  state.flush(allowed); show(state);
  state.receive([], false, () => true);
  assert.equal(state.receive([a], false, () => true).announcements.length, 0);
  assert.equal(state.unreadCount, 1);
});
