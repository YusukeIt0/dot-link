import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { crc32, gunzipSync } from 'node:zlib';
import { compareRainRateSamples, decodeRainRate, probeRainRateFrame } from '../server/weather/rain-rate/decoder.ts';
import { frameFromKey } from '../server/weather/rain-rate/discovery.ts';
import { summarizeRainRate } from '../server/weather/rain-rate/raster.ts';

const key = 'BLEND/RainRate-Blend-INST/2026/11/20/16/RRQPE-INST-GLB-1_v1r1_blend_s202611201640000_e202611201649599_c202611201654584.nc';
const seam = {latitude: 0, longitude: -180};
const freshSignal = () => AbortSignal.timeout(5000);
async function setup() {
  const dir = await mkdtemp(join(tmpdir(),'rain-decoder-')), path = join(dir,'frame');
  const bytes = gunzipSync(await readFile(new URL('./fixtures/rain-rate.nc.gz', import.meta.url)));
  await writeFile(path,bytes);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(bytes));
  const frame = frameFromKey(key, '"'+ '0'.repeat(32)+'"', bytes.length, Date.parse('2026-11-20T16:55:35Z'))!;
  return {dir, path, bytes, edition: {...frame, checksum:sum.toString('base64')}};
}

test('isolated HDF decoder preserves quality, missing pixels, mm/h and wrapping on the real grid shape',async t => {
  const {dir,path,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  const sample = await decodeRainRate(path,edition,seam,freshSignal());
  assert.equal(sample.status,'partial');
  assert.deepEqual(sample.metadata,{coverage_start:'2026-11-20T16:40:00Z',coverage_end:'2026-11-20T16:49:00Z',
    created:'2026-11-20T16:54:58Z', sensors:['ABI-g19'], missing_inputs:4, pixel_observed_at:null});
  const center=sample.areas[0];
  assert.equal(center.nominal,2); assert.equal(center.wet_nominal,1); assert.equal(center.peak_nominal_mm_h,12.3);
  assert.equal(center.degraded,1); assert.equal(center.wet_degraded,1); assert.equal(center.missing_or_bad,center.cells-3);
  const east = await decodeRainRate(path,edition,{...seam,longitude:180},freshSignal());
  assert.deepEqual(east.areas,sample.areas); assert.deepEqual(east.nominal_cohorts,sample.nominal_cohorts);
  const empty = await decodeRainRate(path,edition,{latitude:70,longitude:0},freshSignal());
  assert.equal(empty.status,'no_usable_cells'); assert.equal(empty.edge_clipped,true);
  assert.ok(empty.areas.every(a=>a.peak_nominal_mm_h===null && a.cells===a.missing_or_bad));
});

test('wrong CRC, untrusted cache file and mismatched source metadata fail before producing evidence',async t => {
  const {dir,path,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  await assert.rejects(decodeRainRate(path,{...edition,checksum:'AAAAAA=='},seam,freshSignal()));
  await symlink(path,join(dir,'link'));
  await assert.rejects(decodeRainRate(join(dir,'link'),edition,seam,freshSignal()));
  const earlier = frameFromKey(key.replace('201654584','201654474'),edition.etag,edition.size,edition.published)!;
  await assert.rejects(decodeRainRate(path,{...earlier,checksum:edition.checksum},seam,freshSignal()));
});

test('staged probe accepts missing local coverage and distinguishes an incompatible grid from an unverifiable file', async t => {
  const {dir,path,bytes,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  // The fixture has no rain or quality coverage at the probe city. Its schema and tile still decode.
  assert.equal(await probeRainRateFrame(path,edition,freshSignal()),'supported');
  await assert.rejects(probeRainRateFrame(path,{...edition,checksum:'AAAAAA=='},freshSignal()));
  await assert.rejects(probeRainRateFrame(join(dir,'inaccessible'),edition,freshSignal()));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(probeRainRateFrame(path,edition,controller.signal),{name:'AbortError'});

  // This fixed-width HDF attribute changes the grid convention, leaving a readable HDF5 file.
  const pos = bytes.indexOf('degrees_north'); assert.ok(pos > 0);
  bytes.write('degrees_south',pos,'ascii');
  await writeFile(path,bytes);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(bytes));
  assert.equal(await probeRainRateFrame(path,{...edition,checksum:checksum.toString('base64')},freshSignal()),'unsupported');
});

test('an overlapping decode is bounded, cancellation releases the slot, and an unsupported point gives no cells',async t => {
  const {dir,path,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  const controller = new AbortController();
  const first = decodeRainRate(path,edition,seam,controller.signal);
  await assert.rejects(decodeRainRate(path,edition,seam,freshSignal()));
  controller.abort();
  await assert.rejects(first,{name:'AbortError'});
  const unsupported = await decodeRainRate(path,edition,{latitude:-60.01,longitude:10},freshSignal());
  assert.equal(unsupported.status,'outside_extent'); assert.deepEqual(unsupported.areas,[]);
});

test('a pending promotion gets the next worker before a follow-up read and only one probe may wait', async t => {
  const {dir,path,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  const read = decodeRainRate(path,edition,seam,freshSignal());
  const [verdict] = await Promise.all([
    probeRainRateFrame(path,edition,freshSignal()),
    (async () => {
      await assert.rejects(probeRainRateFrame(path,edition,freshSignal()));
      await assert.rejects(decodeRainRate(path,edition,seam,freshSignal()));
      await read;
      await assert.rejects(decodeRainRate(path,edition,seam,freshSignal()));
    })(),
  ]);
  assert.equal(verdict,'supported');
  assert.equal((await decodeRainRate(path,edition,seam,freshSignal())).status,'partial');
});

test('an expired queued probe frees its place, and aborting the current read hands off to its replacement', async t => {
  const {dir,path,edition} = await setup(); t.after(() => rm(dir,{recursive:true,force:true}));
  const reader = new AbortController(), waiter = new AbortController();
  const read = decodeRainRate(path,edition,seam,reader.signal);
  const canceledRead = assert.rejects(read,{name:'AbortError'});
  const probe = probeRainRateFrame(path,edition,waiter.signal);
  waiter.abort(new DOMException('Deadline reached','TimeoutError'));
  await assert.rejects(probe,{name:'TimeoutError'});
  const replacement = probeRainRateFrame(path,edition,freshSignal());
  reader.abort();
  await canceledRead;
  assert.equal(await replacement,'supported');
});

const meta = {coverage_start:'2026-11-20T16:40:00Z',coverage_end:'2026-11-20T16:49:00Z',created:'2026-11-20T16:54:58Z',
  sensors:['ABI-g19'],missing_inputs:4,pixel_observed_at:null};
test('changes compare only nominal cohorts in the same sector, place and input constellation across distinct windows',() => {
  const point={latitude:0,longitude:0};
  // Two western columns have the same number of good cells but different footprints.
  const sample=(swap:boolean,time:string)=>summarizeRainRate(point,{...meta,coverage_start:time},(r0,r1,c0,c1)=>{
    const rain=new Int16Array((r1-r0)*(c1-c0)).fill(10), quality=new Int8Array(rain.length);
    for(let row=r0;row<r1;row++) for(let col=c0;col<c1;col++) if(row===3500 && col===(swap?8995:8996)) quality[(row-r0)*(c1-c0)+col-c0]=3;
    return {rain,quality};
  });
  const first=sample(false,'2026-11-20T16:30:00Z'), second=sample(true,'2026-11-20T16:40:00Z');
  assert.equal(first.areas[7].nominal,second.areas[7].nominal);
  const areas=compareRainRateSamples(first,second).map(a=>a.area);
  assert.ok(areas.includes('within_5_km')); assert.ok(!areas.includes('W'));
  assert.deepEqual(compareRainRateSamples(first,first),[]);
  assert.deepEqual(compareRainRateSamples(second,first),[]);
  assert.deepEqual(compareRainRateSamples(first,{...second,point:{...point,longitude:1}}),[]);
  assert.deepEqual(compareRainRateSamples(first,{...second,metadata:{...second.metadata,sensors:['ABI-g18']}}),[]);
  assert.deepEqual(compareRainRateSamples(first,sample(true,'2026-11-20T17:10:00Z')),[]);
});
