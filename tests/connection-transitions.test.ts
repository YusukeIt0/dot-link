import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionTransitions } from '../src/connection-transitions.ts';
import type { RelayCredentials } from '../src/relay-connection.ts';
const saved: RelayCredentials = {origin:'https://relay.example',token:'x'.repeat(43),appOrigin:'https://app.example',expiresAt:1893456000000};
function fixture(initial: RelayCredentials | undefined = saved) {
  const events: unknown[] = [];
  const session = {
    credentials: initial as RelayCredentials | undefined,
    restart: () => { events.push('restart'); },
    use: (next: RelayCredentials | undefined) => { events.push('use'); session.credentials=next; },
    save: (next: RelayCredentials) => { events.push('save'); session.credentials=next; return true; },
    forget: () => { events.push('forget'); session.credentials=undefined; },
  };
  const transitions=new ConnectionTransitions({session,
    stopUpdates:()=>{events.push('updates');},cancelPlayback:()=>{events.push('playback');},
    stopLocation:()=>{events.push(['location',session.credentials?.origin]);},
    clearLegacyPairing:()=>{events.push('legacy');},
    resetInteraction:(pairing,identity)=>{events.push(['interaction',pairing,identity]);},
    resetConversation:()=>{events.push('conversation');},
    resetDelivery:(origin,clear)=>{events.push(['delivery',origin,clear]);},
    resetConnectionInfo:()=>{events.push('connection-info');},
  });
  return {transitions,events,session};
}
test('pair attempt cancels the old request lifetime and speech but retains retry/history until success',()=>{
 const f=fixture();f.transitions.beginPairing();assert.deepEqual(f.events,['updates','restart','playback']);
 assert.equal(f.session.credentials,saved);
});
test('same-origin restore preserves conversation and retry identity while resetting transient interaction',()=>{
 const f=fixture();f.transitions.restore({...saved,token:'n'.repeat(43)});
 assert.deepEqual(f.events,['updates','restart','playback','use',['interaction',false,false],['delivery',saved.origin,false],'connection-info']);
});
test('changed or missing restored origin clears previous identity even when incoming history is empty',()=>{
 for(const next of [undefined,{...saved,origin:'https://other.example'}]) {
  const f=fixture();f.transitions.restore(next);
  assert.deepEqual(f.events,['updates','restart','playback','use',['interaction',false,true],'conversation',['delivery',next?.origin,true],'connection-info']);
 }
});
test('new pairing clears identity-scoped state and retains the pairing busy gate until initial snapshot',()=>{
 const f=fixture();assert.equal(f.transitions.paired(saved),true);
 assert.deepEqual(f.events,['save','legacy',['interaction',true,true],'conversation',['delivery',saved.origin,true],'connection-info']);
});
test('forget revokes location before dropping credentials and clears all conversation/retry state',()=>{
 const f=fixture();f.transitions.forget();
 assert.deepEqual(f.events,[['location',saved.origin],'updates','restart','playback','forget','legacy',['interaction',false,true],'conversation',['delivery',undefined,true],'connection-info']);
 assert.equal(f.session.credentials,undefined);
});
