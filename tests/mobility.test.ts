import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {MobilityNetwork} from '../server/mobility/network.ts';
import {crc32, decodeTerrarium} from '../server/mobility/terrarium.ts';
import {TerrainProvider, samplePath} from '../server/mobility/terrain.ts';

function chunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length);
  result.write(type, 4); data.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4,-4)), result.length - 4); return result;
}
function tile(filter = 0, alpha?: number) {
  const channels = alpha === undefined ? 3 : 4, stride = 256 * channels;
  const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  const data = Buffer.alloc(256 * (stride + 1));
  const pixels = Buffer.alloc(256 * stride);
  for (let y = 0; y < 256; y++) for(let x = 0; x < 256; x++) {
    const i = y * stride + x * channels; pixels[i] = 128; pixels[i+1] = x; pixels[i+2] = 128;
    if (channels === 4) pixels[i+3] = alpha!;
  }
  for(let y = 0; y < 256; y++) {
    data[y * (stride + 1)] = filter;
    for(let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? pixels[i-channels]! : 0,
        b = y ? pixels[i-stride]! : 0, c = y && x >= channels ? pixels[i-stride-channels]! : 0;
      const p = a+b-c, da=Math.abs(p-a), db=Math.abs(p-b), dc=Math.abs(p-c);
      const predictor = [0,a,b,Math.floor((a+b)/2),da<=db&&da<=dc?a:db<=dc?b:c][filter]!;
      data[y*(stride+1)+x+1]=(pixels[i]!-predictor)&255;
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
const abort = () => new AbortController();
const response = (bytes: Buffer | string) => new Response(new Uint8Array(Buffer.from(bytes)));
test('Terrarium reverses all PNG filters, fractions, transparency and validates CRC/size/order', () => {
  for (let filter=0; filter<5; filter++) {
    const heights = decodeTerrarium(tile(filter));
    assert.equal(heights[0],0.5); assert.equal(heights[255],255.5); assert.equal(heights[65535],255.5);
  }
  assert.ok(Number.isNaN(decodeTerrarium(tile(0,0))[0]));
  const damaged=tile(); damaged[50]^=1; assert.throws(()=>decodeTerrarium(damaged),/checksum/);
  assert.throws(()=>decodeTerrarium(tile().subarray(0,-12)),/Truncated/);
  const oversized=tile();oversized.writeUInt32BE(512,16);oversized.writeUInt32BE(crc32(oversized.subarray(12,29)),29);
  assert.throws(()=>decodeTerrarium(oversized),/Unsupported/);
});
test('network rejects oversized streams, redirects policy and unapproved hosts; cancellation releases slots', async () => {
  let calls=0;
  const net=new MobilityNetwork(async (_url, options)=>{
    calls++;assert.equal(options?.redirect,'error'); assert.equal(options?.credentials,'omit');
    return response('123456');
  });
  await assert.rejects(net.bytes(new URL('https://example.com'),abort().signal,10),/Unsupported/);
  assert.equal(calls,0);
  await assert.rejects(net.bytes(new URL('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png'),abort().signal,5),/Oversized/);
  assert.equal((await net.bytes(new URL('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png'),abort().signal,6)).length,6);
  const controller=abort();controller.abort();
  await assert.rejects(net.bytes(new URL('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png'),controller.signal,6),{name:'AbortError'});
  assert.equal(calls,2);
  assert.deepEqual(net.stats(),{requests:2,received_bytes:12});
});
test('network has global three-request cap and no hidden backlog',async()=>{
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);
  const net=new MobilityNetwork(async()=>{await wait;return response('ok');});
  const url=new URL('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/1/1.png');const running=[1,2,3].map(()=>net.bytes(url,abort().signal,10));
  await assert.rejects(net.bytes(url,abort().signal,10),/busy/);release();await Promise.all(running);
  assert.equal((await net.bytes(url,abort().signal,10)).toString(),'ok');
});
test('terrain preserves missing coverage, limits tiles and caches only bounded public rasters',async()=>{
  let calls=0;const net=new MobilityNetwork(async()=>{calls++;return response(tile());});
  const terrain=new TerrainProvider(net);
  const points=Array.from({length:20},(_,i)=>({latitude:0,longitude:i}));
  const values=await terrain.elevations(points,abort().signal);
  assert.equal(calls,12);assert.equal(values.filter(v=>v===null).length,8);
  await terrain.elevations(points.slice(0,2),abort().signal);assert.equal(calls,12);
  terrain.clear();await terrain.elevations(points.slice(0,1),abort().signal);assert.equal(calls,13);
  const unavailable=new TerrainProvider(new MobilityNetwork(async()=>new Response('',{status:404})));
  const result=await unavailable.profile([{latitude:0,longitude:0},{latitude:0,longitude:.001}],abort().signal);
  assert.equal(result.status,'unavailable');assert.equal(result.ascent_m,null);assert.equal(result.maximum_sampled_grade_percent,null);
});
test('terrain stops after cancellation and does not fetch further tiles',async()=>{
  const controller=abort();let calls=0;
  const terrain=new TerrainProvider(new MobilityNetwork(async()=>{calls++;controller.abort();return response(tile());}));
  await assert.rejects(terrain.elevations([{latitude:0,longitude:0},{latitude:0,longitude:1}],controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
});
test('sampled path follows geometry and crosses the dateline by the short direction',()=>{
  const sampled=samplePath([{latitude:0,longitude:179.999},{latitude:0,longitude:-179.999}]);
  assert.ok(sampled.points.every(p=>Math.abs(p.longitude)>179.99));assert.ok(sampled.spacing<=50);
  assert.throws(()=>samplePath([{latitude:0,longitude:0},{latitude:0,longitude:100}]),/bounds/);
});
test('suspect raster jumps withhold route totals instead of publishing an apparent extreme slope',async()=>{
  class SpikyTerrain extends TerrainProvider {
    override async elevations(points: {latitude:number;longitude:number}[],_signal:AbortSignal) {
      return points.map((_,i)=>i===1?100:0);
    }
  }
  const terrain=new SpikyTerrain(new MobilityNetwork(async()=>{throw new Error('No network expected');}));
  const result=await terrain.profile([{latitude:0,longitude:0},{latitude:0,longitude:.001}],abort().signal);
  assert.equal(result.confidence,'suspect_surface_profile');assert.equal(result.status,'partial');
  assert.equal(result.ascent_m,null);assert.equal(result.maximum_sampled_grade_percent,null);
  assert.equal(result.origin_elevation_m,0);assert.match(result.limitations.at(-1)!,/does not establish an impassable/);
});
