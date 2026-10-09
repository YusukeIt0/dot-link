import test from 'node:test';
import assert from 'node:assert/strict';
import { RelaySettings, PendingUtterance, apiAddress } from '../src/relay-connection.ts';
import { chooseLanguage, setLanguage, t, seconds } from '../src/i18n.ts';
const memory = () => {
  const values = new Map<string,string>();
  return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
};
test('paired destination is retained with its credential and expired or malformed settings never load', () => {
  const disk = memory(); const settings = new RelaySettings(()=>disk);
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),expiresAt:Date.now()+100000};
  assert.equal(settings.save(credentials),true);
  assert.deepEqual(new RelaySettings(()=>disk).read(),credentials);
  disk.setItem('dot-relay-v1',JSON.stringify({...credentials,origin:'https://evil.example'})); assert.equal(settings.read(),undefined);
  disk.setItem('dot-relay-v1',JSON.stringify({...credentials,expiresAt:Date.now()-1})); assert.equal(settings.read(),undefined);
  assert.throws(()=>settings.save({...credentials,token:'bad'}));
  assert.throws(()=>apiAddress('//evil.example',credentials.origin));
  assert.equal(apiAddress('/api/updates',credentials.origin),'https://mac.tailtest.ts.net/api/updates');
  settings.forget(); assert.equal(settings.read(),undefined);
});
test('an uncertain delivery reuses its id after relaunch without persisting message text', async () => {
  const disk = memory(); const first = new PendingUtterance(()=>disk,'one');
  const id = await first.prepare('private words');
  assert.equal(await new PendingUtterance(()=>disk,'one').prepare('private words'),id);
  assert.equal(disk.getItem('dot-pending:one')!.includes('private words'),false);
  assert.notEqual(await new PendingUtterance(()=>disk,'two').prepare('private words'),id);
  assert.notEqual(await first.prepare('different message'),id);
  first.clear(); assert.notEqual(await first.prepare('private words'),id);
});
test('language selection covers English fallback and Japanese status', () => {
  assert.equal(chooseLanguage('ja-JP'),'ja'); assert.equal(chooseLanguage('en-US'),'en');
  assert.equal(chooseLanguage('fr-FR'),'en'); assert.equal(chooseLanguage('en-US','ja'),'ja');
  setLanguage('en'); assert.equal(t('Dotの返信待ち'),'Waiting for Dot'); assert.equal(seconds(2),'2s');
  setLanguage('ja'); assert.equal(t('Dotの返信待ち'),'Dotの返信待ち'); assert.equal(seconds(2),'2秒');
});

test('native pairing survives a new WebView origin and explicit logout defeats stale local caches', async () => {
  const host = memory();
  const native = {getLocalStorage: async (k:string)=>host.getItem(k)??'',setLocalStorage:async(k:string,v:string)=>{host.setItem(k,v);return true;}};
  const oldWeb = memory(), oldApp = new RelaySettings(()=>oldWeb);
  await oldApp.attach(native);
  const credentials = {origin:'https://mac.tailtest.ts.net',token:'a'.repeat(43),resumeToken:'b'.repeat(43),appOrigin:'http://127.0.0.1:55895',expiresAt:Date.now()+100000};
  oldApp.save(credentials); assert.equal(await oldApp.nativeSaved(), true);
  const newWeb = memory(), updatedApp = new RelaySettings(()=>newWeb);
  assert.equal(updatedApp.read(), undefined);
  assert.deepEqual(await updatedApp.attach(native), credentials);
  assert.deepEqual(updatedApp.read(), credentials);
  updatedApp.forget(); assert.equal(await updatedApp.nativeSaved(), true);
  assert.equal(await new RelaySettings(()=>oldWeb).attach(native), undefined, 'native logout suppresses old port cache');
  assert.equal(new RelaySettings(()=>oldWeb).read(), undefined);
});

test('late native restore cannot overwrite a new pairing or undo logout; failed host writes are not reported as durable', async () => {
  let resolveRead!: (v:string)=>void;
  const writes:string[]=[];
  const native = {getLocalStorage:()=>new Promise<string>(r=>{resolveRead=r}),setLocalStorage:async(_k:string,v:string)=>{writes.push(v);return true;}};
  const disk = memory(), settings = new RelaySettings(()=>disk);
  const first = {origin:'https://one.tailtest.ts.net',token:'a'.repeat(43),expiresAt:Date.now()+100000};
  const second = {...first,origin:'https://two.tailtest.ts.net',token:'b'.repeat(43)};
  const restoring = settings.attach(native); settings.save(second); resolveRead(JSON.stringify(first));
  assert.deepEqual(await restoring, second); await settings.nativeSaved();
  const restoringAgain = settings.attach(native); settings.forget(); resolveRead(JSON.stringify(first));
  assert.equal(await restoringAgain, undefined); await settings.nativeSaved();
  assert.equal(writes.at(-1), 'null');
  const failed = new RelaySettings(()=>memory());
  await failed.attach({getLocalStorage:async()=>'',setLocalStorage:async()=>false});
  failed.save(first); assert.equal(await failed.nativeSaved(), false);
});
