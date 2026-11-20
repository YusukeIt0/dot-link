import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {crc32} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {RainRateService} from '../server/weather/rain-rate/service.ts';
import {acquireFrame, chooseEdition, frameFromKey, freshFrame, parseListing, FRAME_AGE, LIST_LIMIT, OBJECT_LIMIT} from '../server/weather/rain-rate/discovery.ts';
import {COOLDOWN, DAILY_BYTES, FETCH_TIMEOUT, RainRateCache} from '../server/weather/rain-rate/cache.ts';
import type {decodeRainRate, RainRateSample} from '../server/weather/rain-rate/decoder.ts';

const minute = 60_000;
const start = Date.UTC(2026, 10, 20, 23, 50);
const payload = Buffer.from([137, 72, 68, 70, 13, 10, 26, 10, 2, 4, 6, 8]);
const checksum = Buffer.alloc(4);
checksum.writeUInt32BE(crc32(payload));
const etag = '"12345678123456781234567812345678"';
const active = () => new AbortController().signal;
const point = {latitude: 13.7563, longitude: 100.5018};
function stamp(t: number) {return new Date(t).toISOString().replace(/[-:T.Z]/g, '').slice(0, 15);}
function edition(s = start, inputs = 5, delay = 3 * minute, size = payload.length) {
  const d = new Date(s).toISOString(), e = s + 599_900, c = s + 600_000 + delay;
  const prefix = 'BLEND/RainRate-Blend-INST/' + [d.slice(0, 4), d.slice(5, 7), d.slice(8, 10), d.slice(11, 13)].join('/') + '/';
  const key = prefix + 'RRQPE-INST-GLB-' + inputs + '_v1r1_blend_s' + stamp(s) + '_e' + stamp(e) + '_c' + stamp(c) + '.nc';
  return frameFromKey(key, etag, size, c + 1000)!;
}
type Frame = ReturnType<typeof edition>;
function listing(prefix: string, frames: Frame[]) {
  const entries = frames.filter(f => f.key.startsWith(prefix)).map(f => '<Contents><Key>' + f.key + '</Key><LastModified>' + new Date(f.published).toISOString() + '</LastModified><ETag>' +
    f.etag.replaceAll('"', '&quot;') + '</ETag><ChecksumAlgorithm>CRC32</ChecksumAlgorithm><ChecksumType>FULL_OBJECT</ChecksumType><Size>' + f.size + '</Size></Contents>');
  return '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>noaa-enterprise-rainrate-pds</Name><Prefix>' + prefix + '</Prefix><KeyCount>' +
    entries.length + '</KeyCount><IsTruncated>false</IsTruncated>' + entries.join('') + '</ListBucketResult>';
}
function headers(f: Frame) {
  return {
    'content-length': String(f.size), etag: f.etag, 'x-amz-checksum-type': 'FULL_OBJECT', 'x-amz-checksum-crc32': checksum.toString('base64'),
    'last-modified': new Date(f.published).toUTCString()
  };
}
function control(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rain-rate-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  let now = start + 14 * minute, frames = [edition()];
  const seen: {url: URL; options?: RequestInit}[] = [];
  const request: typeof fetch = async (url, options) => {
    const u = new URL(String(url)); seen.push({url: u, options});
    assert.equal(u.hostname, 'noaa-enterprise-rainrate-pds.s3.us-east-1.amazonaws.com');
    assert.equal(options?.redirect, 'error');
    if (u.search) return new Response(listing(u.searchParams.get('prefix')!, frames));
    const f = frames.find(row => row.key === u.pathname.slice(1))!;
    assert.equal(new Headers(options?.headers).get('if-match'), f.etag);
    assert.equal(new Headers(options?.headers).get('x-amz-checksum-mode'), 'ENABLED');
    return new Response(payload, {headers: headers(f)});
  };
  const decode: typeof decodeRainRate = async (path, frame, p, sig) => {
    sig.throwIfAborted();
    assert.deepEqual(readFileSync(path), payload); assert.equal(frame.checksum, checksum.toString('base64'));
    return {cell: [p.latitude, p.longitude]} as unknown as RainRateSample;
  };
  return {
    directory, seen, request, decode, now: () => now, advance: (ms: number) => {now += ms;}, set: (f: Frame[]) => {frames = f;},
    service: (overrides: {request?: typeof fetch; decode?: typeof decodeRainRate} = {}) => new RainRateService(directory, {request, decode, now: () => now, ...overrides})
  };
}
test('discovery checks hours, production filename and digest capability, and selects one edition per observation window', () => {
  const full = edition(), partial = edition(start, 2, minute), next = edition(start + 10 * minute, 2);
  const prefix = full.key.slice(0, full.key.lastIndexOf('/') + 1), now = next.published + 1;
  const xml = listing(prefix, [partial, full]);
  assert.deepEqual(parseListing(xml, prefix, now), [partial, full]);
  assert.equal(chooseEdition([partial, next, full]), full);
  assert.equal(chooseEdition([full, edition(start + 20 * minute, 3)])!.inputs, 3);
  for (const invalid of [xml.replace('v1r1', 'v2r1'), xml.replace('CRC32', 'SHA256'), xml.replace('GLB-2', 'GLB-8'), xml.replace('s202611202350', 's202613202350')])
    assert.deepEqual(parseListing(invalid, prefix, now), [full]);
  for (const invalid of [xml.replace('false', 'true'), xml.replace('<KeyCount>2', '<KeyCount>1'), '<!DOCTYPE test>' + xml])
    assert.throws(() => parseListing(invalid, prefix, now));
  assert.equal(freshFrame(full, full.published - 1), false);
  assert.equal(freshFrame(full, Math.floor(full.end / minute) * minute + FRAME_AGE + 1), false);
});
test('anonymous whole-object acquisition crosses midnight; local reads reuse one frame across places and restart without network', async t => {
  const f = control(t), first = f.service();
  assert.deepEqual(await first.read(point, active()), []);
  assert.equal(f.seen.length, 0);
  assert.equal(await first.refresh(active()), 'updated');
  const lists = f.seen.filter(x => x.url.search);
  assert.deepEqual(lists.map(x => x.url.searchParams.get('prefix')!.slice(-6)), ['21/00/', '20/23/']);
  assert.equal(f.seen.length, 3);
  const initial = (await first.read(point, active()))[0];
  const other = await f.service().read({latitude: -33.9, longitude: 151.2}, active());
  assert.deepEqual(other[0].frame, initial.frame); assert.notDeepEqual(other[0].sample, initial.sample);
  await f.service().refresh(active()); assert.equal(f.seen.length, 3);
  for (const {url, options} of f.seen) {
    assert.doesNotMatch(String(url), /13\.7563|100\.5018|latitude|longitude/);
    assert.equal(new Headers(options?.headers).get('range'), null);
  }
  f.advance(COOLDOWN);
  assert.equal(await first.refresh(active()), 'cached');
  assert.equal(f.seen.filter(x => !x.url.search).length, 1);
  assert.equal((await first.read(point, active()))[0].frame.retrieved, initial.frame.retrieved);
  f.advance(FRAME_AGE);
  assert.deepEqual(await f.service().read(point, active()), []);
});
test('full-object transport rejects changed identity, lengths, digest, partial HTTP bodies and non-HDF data', async () => {
  const f = edition(), good = headers(f);
  const reserve = (n: number) => assert.equal(n, f.size);
  const invalid: Array<() => Response> = [
    () => new Response(payload, {headers: {...good, etag: '"other"'}}), () => new Response(payload, {headers: {...good, 'x-amz-checksum-type': 'COMPOSITE'}}),
    () => new Response(payload, {headers: {...good, 'x-amz-checksum-crc32': 'AAAAAA=='}}), () => new Response(payload, {headers: {...good, 'content-length': '99'}}),
    () => new Response(payload.subarray(0, 8), {headers: good}), () => new Response(Buffer.concat([payload, payload]), {headers: good}),
    () => new Response(payload, {status: 206, headers: good}), () => new Response(payload, {headers: {...good, 'content-encoding': 'gzip'}}),
    () => new Response(Buffer.alloc(payload.length), {headers: good})];
  for (const response of invalid) await assert.rejects(acquireFrame(f, async () => response(), reserve, active()));
  await assert.rejects(acquireFrame({...f, key: 'https://untrusted.invalid/'}, async () => assert.fail(), reserve, active()));
});
test('same-window improved editions replace the receipt; distinct later windows retain at most three public files', async t => {
  const f = control(t), service = f.service();
  f.set([edition(start, 2, minute)]);
  assert.equal(await service.refresh(active()), 'updated');
  f.advance(COOLDOWN); f.set([edition(start, 2, minute), edition(start, 5, 12 * minute)]);
  assert.equal(await service.refresh(active()), 'updated');
  const updated = await service.read(point, active(), {previous: true});
  assert.deepEqual(updated.map(r => r.frame.inputs), [5]);
  for (let i = 1; i <= 4; i++) {
    f.advance(COOLDOWN); f.set([edition(start + i * 10 * minute)]);
    assert.equal(await service.refresh(active()), 'updated');
  }
  const recent = await f.service().read(point, active(), {previous: true});
  assert.deepEqual(recent.map(r => r.frame.start), [start + 40 * minute, start + 30 * minute]);
  assert.equal(readdirSync(f.directory).filter(n => n.endsWith('.nc')).length, 3);
  assert.ok(!readdirSync(f.directory).includes('.incoming'));
});
test('started acquisition is charged before response; other service cannot overlap and revocation cancels the stream', async t => {
  const f = control(t), auth = new AbortController();
  let startObject!: () => void; const waiting = new Promise<void>(resolve => {startObject = resolve;});
  const service = f.service({
    request: async (url, opts) => {
      if (new URL(String(url)).search) return f.request(url, opts);
      startObject();
      return new Response(new ReadableStream({start(c) {c.enqueue(payload.subarray(0, 5));} }), {headers: headers(edition())});
    }
  });
  const work = service.refresh(auth.signal); await waiting;
  const db = new DatabaseSync(join(f.directory, 'frames.sqlite'), {readOnly: true});
  const held = Number(db.prepare('SELECT sum(bytes) AS bytes FROM transfers').get()!.bytes); db.close();
  assert.ok(held >= OBJECT_LIMIT);
  const other = f.service(); assert.equal(await other.refresh(active()), 'unavailable');
  assert.deepEqual(await other.read(point, active()), []);
  auth.abort(); assert.equal(await work, 'unavailable');
  assert.deepEqual(await f.service().read(point, active()), []);
  assert.equal(readdirSync(f.directory).filter(n => n.endsWith('.nc') || n === '.incoming').length, 0);
  const after = new DatabaseSync(join(f.directory, 'frames.sqlite'), {readOnly: true});
  assert.equal(after.prepare('SELECT sum(bytes) AS bytes FROM transfers').get()!.bytes, 2 * LIST_LIMIT + payload.length); after.close();
  const calls = f.seen.length; await other.refresh(active()); assert.equal(f.seen.length, calls);
});
test('rolling byte cap crosses process restarts and midnight and only frees reservations after a full day', async t => {
  const f = control(t); let objectRequests = 0;
  const service = () => f.service({
    request: async (url) => {
      const u = new URL(String(url)); const s = Math.floor((f.now() - 14 * minute) / (10 * minute)) * 10 * minute;
      const frame = edition(s, 5, 2 * minute, OBJECT_LIMIT);
      if (u.search) return new Response(listing(u.searchParams.get('prefix')!, [frame]));
      objectRequests++; return new Response('unavailable', {status: 503});
    }
  });
  for (let i = 0; i < 12; i++) {await service().refresh(active()); f.advance(COOLDOWN);}
  assert.equal(objectRequests, 7);
  const db = new DatabaseSync(join(f.directory, 'frames.sqlite'), {readOnly: true});
  assert.ok(Number(db.prepare('SELECT sum(bytes) AS total FROM transfers').get()!.total) <= DAILY_BYTES); db.close();
  f.advance(24 * 60 * minute + FETCH_TIMEOUT);
  await service().refresh(active()); assert.equal(objectRequests, 8);
});
test('cached files and concurrent position reads cannot return evidence for another request or after revocation', async t => {
  const f = control(t); const seed = f.service(); await seed.refresh(active());
  let finish!: () => void; const gate = new Promise<void>(r => {finish = r;});
  let entered!: () => void; const started = new Promise<void>(r => {entered = r;});
  const service = f.service({decode: async (...args) => {entered(); await gate; return f.decode(...args);}});
  const auth = new AbortController(), work = service.read(point, auth.signal);
  await started; assert.deepEqual(await service.read({latitude: 1, longitude: 2}, active()), []);
  auth.abort(); finish(); assert.deepEqual(await work, []);
  const file = join(f.directory, readdirSync(f.directory).find(n => n.endsWith('.nc'))!);
  writeFileSync(file, 'damaged');
  assert.deepEqual(await seed.read(point, active()), []);
  seed.close(); assert.deepEqual(await seed.read(point, active()), []); assert.equal(await seed.refresh(active()), 'unavailable');
});
test('cache remains readable during a network refresh and never publishes a superseded in-flight same-window read', async t => {
  const f = control(t), seed = f.service(); f.set([edition(start, 2, minute)]);
  await seed.refresh(active());
  const before = (await seed.read(point, active()))[0].frame;
  f.advance(COOLDOWN); f.set([edition(start, 5, 12 * minute)]);
  let unblock!: () => void, objectStarted!: () => void;
  const held = new Promise<void>(r => {unblock = r;});
  const requesting = new Promise<void>(r => {objectStarted = r;});
  const updater = f.service({
    request: async (url, options) => {
      if (!new URL(String(url)).search) {objectStarted(); await held;}
      return f.request(url, options);
    }
  });
  const refreshing = updater.refresh(active()); await requesting;
  assert.deepEqual((await f.service().read(point, active()))[0].frame, before);
  let decoded!: () => void, complete!: () => void;
  const reading = new Promise<void>(r => {decoded = r;});
  const pause = new Promise<void>(r => {complete = r;});
  const reader = f.service({decode: async (...args) => {const result = await f.decode(...args); decoded(); await pause; return result;}});
  const old = reader.read(point, active()); await reading;
  unblock(); assert.equal(await refreshing, 'updated'); complete();
  assert.deepEqual(await old, []);
  assert.equal((await seed.read(point, active()))[0].frame.inputs, 5);
});
test('missing or invalid provider data and unreadable quota state fail quietly', async t => {
  const f = control(t), s = f.service(); f.set([]); assert.equal(await s.refresh(active()), 'unavailable');
  assert.deepEqual(await s.read(point, active()), []);
  const count = f.seen.length; f.advance(-minute); await f.service().refresh(active()); assert.equal(f.seen.length, count);
  writeFileSync(join(f.directory, 'frames.sqlite'), 'unreadable budget');
  f.advance(2 * COOLDOWN); assert.equal(await f.service().refresh(active()), 'unavailable'); assert.equal(f.seen.length, count);
});
test('failed index commit and an interrupted publication retain the usable edition and reap only staged files', async t => {
  const f=control(t), service=f.service();
  const early=edition(start,2,minute), late=edition(start,5,12*minute);
  f.set([early]); assert.equal(await service.refresh(active()),'updated');
  const saved=(await service.read(point,active()))[0];
  f.advance(COOLDOWN); f.set([late]);
  const path=join(f.directory,'frames.sqlite'), db=new DatabaseSync(path);
  db.exec(`CREATE TABLE fault_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON frames BEGIN INSERT INTO fault_child VALUES(1); END;`);
  db.close();
  assert.equal(await service.refresh(active()),'unavailable');
  assert.deepEqual((await f.service().read(point,active()))[0],saved);
  assert.equal(readdirSync(f.directory).filter(n=>n.endsWith('.nc')).length,1);
  const repaired=new DatabaseSync(path); repaired.exec('DROP TRIGGER fail_commit'); repaired.close();

  // Stop a second process after the staged rename, before its SQLite commit.
  // SQLite and the next reader must recover without disposing of the old file.
  f.advance(COOLDOWN);
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `import {RainRateCache} from ${JSON.stringify(new URL('../server/weather/rain-rate/cache.ts',import.meta.url).href)};
     const [dir,time,frame,crc,raw]=process.argv.slice(1);
     const cache=new RainRateCache(dir);
     await cache.acquire(Number(time),async reserve=>{
       const bytes=Buffer.from(raw,'hex');reserve(bytes.length);
       cache.store(JSON.parse(frame),crc,bytes,Number(time));process.exit(0);
     });process.exit(2);`,
    f.directory,String(f.now()),JSON.stringify(late),checksum.toString('base64'),payload.toString('hex')],{timeout:5000});
  assert.equal(child.status,0,child.stderr.toString());
  assert.equal(readdirSync(f.directory).filter(n=>n.endsWith('.nc')).length,2);
  assert.deepEqual((await f.service().read(point,active()))[0],saved);
  assert.equal(readdirSync(f.directory).filter(n=>n.endsWith('.nc')).length,1);
  const files=readdirSync(f.directory);
  assert.ok(!files.includes('.incoming'));
});
test('same-sized corrupted bytes are suppressed locally and reacquired with their original receipt clock', async t=>{
  const f=control(t);let calls=0;
  const service=f.service({decode:async(...args)=>{calls++;return f.decode(...args);}});
  await service.refresh(active());const initial=(await service.read(point,active()))[0];
  const path=join(f.directory,readdirSync(f.directory).find(n=>n.endsWith('.nc'))!);
  writeFileSync(path,Buffer.alloc(payload.length));
  assert.deepEqual(await service.read(point,active()),[]);
  assert.deepEqual(await service.read(point,active()),[]);assert.equal(calls,2);
  f.advance(COOLDOWN);assert.equal(await service.refresh(active()),'updated');
  assert.deepEqual((await service.read(point,active()))[0],initial);
  writeFileSync(path,Buffer.alloc(payload.length));
  f.advance(COOLDOWN);assert.equal(await f.service().refresh(active()),'updated');
  assert.deepEqual((await service.read(point,active()))[0],initial);
});
test('a failed staged rename can never displace the cached same-window edition', async t => {
  const f=control(t), seed=f.service();
  f.set([edition(start,2,minute)]);await seed.refresh(active());
  const initial=await seed.read(point,active());
  const late=edition(start,5,12*minute), cache=new RainRateCache(f.directory);
  const target=cache.path({...late,checksum:checksum.toString('base64')});cache.close();
  f.advance(COOLDOWN);f.set([late]);
  const updater=f.service({request:async(url,opts)=>{
    if (!new URL(String(url)).search) mkdirSync(target); // deterministic EISDIR on rename
    return f.request(url,opts);
  }});
  assert.equal(await updater.refresh(active()),'unavailable');
  assert.deepEqual(await seed.read(point,active()),initial);
  rmdirSync(target);
  assert.deepEqual(await f.service().read(point,active()),initial);
});
