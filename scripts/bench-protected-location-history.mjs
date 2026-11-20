// Manual synthetic benchmark: node scripts/bench-protected-location-history.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveAuthority } from '../server/history/archive-authority.ts';
import { LocationHistoryStore } from '../server/history/store.ts';

const directory = mkdtempSync(join(tmpdir(), 'dot-protected-location-bench-'));
const start = Date.UTC(2025, 0, 5), day = 86_400_000;
const owner = 'a'.repeat(64), key = randomBytes(32);
const now = () => clock, iso = time => new Date(time).toISOString();
let clock = start, store, authority;

async function open() {
  authority = new ArchiveAuthority(join(directory, 'p'), {
    create: async () => ({key:Buffer.from(key), wrapped:'synthetic-benchmark'}),
    open: async () => Buffer.from(key),
  }, {now, ownerStatus: () => 'authorized', locationContinuity: () => store?.continuity()});
  store = new LocationHistoryStore(join(directory,'l'), {
    now, archive: () => authority, ownerAuthorized: id => id === owner, announce: async () => {},
  });
  await authority.restore();
}
function measure(n, work) {
  const samples = [];
  for (let i = 0; i < n + 2; i++) {
    const began = performance.now();
    work(i);
    if (i >= 2) samples.push(performance.now() - began);
  }
  samples.sort((a,b) => a-b);
  const percentile = fraction => Number(samples[Math.ceil(n*fraction)-1].toFixed(3));
  return {trials:n, p50_ms:percentile(.5), p95_ms:percentile(.95)};
}
function page(from) {
  return store.readSelectedHistory({start_at:iso(from), end_at:iso(from+3_600_000), fields:['motion'], limit:50});
}

try {
  await open();
  const initial = await authority.status(owner);
  const on = await store.controlArchive(owner, initial.epoch, {action:'set',source:'location',enabled:true});
  await authority.control(owner,on.epoch,{action:'period',period:'1y'});
  const metadata = {protocol:1,epoch:store.status(owner).historyEpoch,timezone:'Etc/UTC',utc_offset_minutes:0};
  const began = performance.now();
  let rows = 0;
  for (let date = 0; date < 365; date++) {
    const count = date >= 362 ? 1920 : 24;
    for (let i = 0; i < count; i++) {
      clock = start + date*day + i*day/count;
      const fix = {measured_at:iso(clock), latitude:0, longitude:0, accuracy:8, speed:1, heading:90};
      assert.ok(store.ingest(fix, 'benchmark-session', metadata, owner));
      rows++;
    }
  }
  const ingest_s = Number(((performance.now()-began)/1000).toFixed(3));
  const sources = join(directory,'p','sources');
  const archive_bytes = readdirSync(sources).reduce((sum,name) => sum+statSync(join(sources,name)).size,0);
  const legacy_bytes = statSync(join(directory,'l','history.sqlite')).size;
  store.close(); authority.close();
  const reopening = performance.now();
  await open();
  const reopen_ms = Number((performance.now()-reopening).toFixed(3));
  const old_hour = measure(20,i => assert.equal(page(start+(i+1)*day).entries.length,1));
  const recent_hour = measure(20,i => {
    const result = page(start+363*day+i*3_600_000);
    assert.equal(result.entries.length,50);
    assert.ok(result.next_cursor);
  });
  const receipt_clock = measure(7,() => {
    const result = store.readPhoneTime([iso(start+363*day).slice(0,10)],owner);
    assert.equal(result.evidence.status,'available'); assert.ok(result.allowed());
  });
  console.log(JSON.stringify({node:process.version,rows,days:365,sparse_per_day:24,dense_days:3,dense_spacing_ms:45_000,
    archive_bytes,legacy_bytes,ingest_s,reopen_ms,old_hour,recent_hour,receipt_clock},null,2));
} finally {
  store?.close(); authority?.close(); key.fill(0); rmSync(directory,{recursive:true,force:true});
}
