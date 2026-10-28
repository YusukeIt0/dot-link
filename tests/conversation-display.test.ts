import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationText, conversationHudText, delayedReply, receiptCaption, newReplyCaption, type DisplayMessage } from '../src/conversation-display.ts';
import { setLanguage } from '../src/i18n.ts';
const now = new Date(2026, 9, 12, 19, 10, 0).getTime();
const message: DisplayMessage = {id:'speech',text:'Synthetic question',status:'accepted',createdAt:new Date(now).toISOString()};

test('URL-only question answers have a G2 hint while original phone text stays unchanged', () => {
  setLanguage('en');
  try {
    const linked = {...message, reply:'https://example.com'};
    assert.equal(conversationHudText(linked,now), 'You: Synthetic question\n\nDot: Link on phone');
    assert.equal(conversationText(linked,now), 'You: Synthetic question\n\nDot: https://example.com');
    assert.equal(linked.reply,'https://example.com');
    assert.match(conversationHudText({...message,text:'See https://example.com',reply:'[Guide](https://example.org)'},now), /You: See\n\nDot: Guide/);
  } finally {setLanguage('ja');}
});

test('receipt uses fixed local send time, changes only its state, and excludes incoming messages', () => {
  setLanguage('ja');
  assert.equal(receiptCaption(message), '未読 19:10');
  assert.equal(receiptCaption({...message,readAt:new Date(now + 45_000).toISOString()}), '既読 19:10');
  assert.equal(receiptCaption({...message,reply:'Answer'}), '既読 19:10');
  for (const kind of ['notification','proactive'] as const) assert.equal(receiptCaption({...message,kind}), '');
  assert.equal(receiptCaption({...message,createdAt:undefined}), '', 'legacy time is not invented');
});
test('delay changes only the reply-wait body at sixty seconds and late replies replace it', () => {
  setLanguage('ja');
  assert.equal(delayedReply(message,now+59_999),false);
  assert.equal(conversationText(message,now+59_999),'あなた: Synthetic question\n\nDot: 返信を待っています…');
  assert.equal(conversationText(message,now+60_000),'あなた: Synthetic question\n\nDot: 通常より返信に時間がかかっています…');
  assert.equal(conversationText({...message,reply:'Late answer'},now+600_000),'あなた: Synthetic question\n\nDot: Late answer');
  assert.equal(delayedReply({...message,status:'failed'},now+600_000),false);
});
test('English uses the same receipt and delayed-wait behavior without translating user text', () => {
  setLanguage('en');
  try {
    assert.equal(receiptCaption(message),'Unread 19:10');
    assert.equal(newReplyCaption(2),'2 new');
    assert.equal(conversationText(message,now+60_000),'You: Synthetic question\n\nDot: The reply is taking longer than usual…');
  } finally { setLanguage('ja'); }
  assert.equal(newReplyCaption(2),'新着2件'); assert.equal(newReplyCaption(0),'');
});

test('expired photo messages give a short resend instruction instead of waiting indefinitely',()=>{
 setLanguage('en');try {
  const expired={...message,text:'',photoCount:2,photosExpired:true};
  assert.match(conversationText(expired,now),/Photos expired\. Please resend\./);
  assert.doesNotMatch(conversationText(expired,now),/Waiting for a reply/);
  assert.match(conversationText({...expired,reply:'Already answered'},now),/Already answered/);
 } finally {setLanguage('ja');}
});
