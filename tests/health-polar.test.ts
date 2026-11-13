import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PolarAPI, POLAR_REDIRECT} from '../server/health/polar.ts';
const NOW=Date.parse('2026-11-14T12:00:00Z');
const signal=()=>new AbortController().signal;
const token=()=>new Response(JSON.stringify({access_token:'fixture-access',token_type:'bearer',expires_in:3600,x_user_id:123}));
test('OAuth code exchanges once, verifies registration conflict, never follows redirects or logs remote errors',async()=>{
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const api=new PolarAPI({now:()=>NOW,fetch:async(url,init)=>{calls.push({url:String(url),init});if(calls.length===1)return token();if(calls.length===2)return new Response('',{status:409});return new Response('{}');}});
  const c=await api.exchange({clientId:'id',clientSecret:'secret'},'single-code',signal());assert.equal(c.userId,123);assert.equal(calls.length,3);
  assert.ok(calls[2].url.endsWith('/users/123'));assert.equal(calls[0].init?.redirect,'error');assert.equal(new URLSearchParams(calls[0].init?.body as URLSearchParams).get('redirect_uri'),POLAR_REDIRECT);
  let count=0;const failed=new PolarAPI({now:()=>NOW,fetch:async()=>++count===1?token():new Response('private-api-error',{status:500})});
  await assert.rejects(failed.exchange({clientId:'id',clientSecret:'secret'},'code',signal()),e=>e instanceof Error&&e.message==='HEALTH_REQUEST_FAILED');assert.equal(count,2);
});
test('rate limiting blocks immediate retries; revoked credentials do not trigger a token replay',async()=>{
  let count=0;const api=new PolarAPI({now:()=>NOW,fetch:async()=>{count++;return new Response('',{status:429,headers:{'Retry-After':'120'}});}});
  for(let n=0;n<2;n++)await assert.rejects(api.exchange({clientId:'id',clientSecret:'secret'},'code',signal()),/HEALTH_RATE_LIMITED/);assert.equal(count,1);
  const revoked=new PolarAPI({now:()=>NOW,fetch:async()=>new Response('private',{status:401})});await assert.rejects(revoked.exchange({clientId:'id',clientSecret:'secret'},'code',signal()),/HEALTH_RECONNECT_REQUIRED/);
});
test('collection excludes routes and can skip a deleted profile; singular heart-rate response remains usable',async()=>{
  const urls:string[]=[];const api=new PolarAPI({now:()=>NOW,fetch:async(url)=>{urls.push(String(url));if(String(url).includes('continuous-heart-rate'))return new Response(JSON.stringify({date:'2026-11-14',heart_rate_samples:[{sample_time:'08:00:00',heart_rate:60}]}));return new Response(null,{status:204});}});
  const result=await api.collect({clientId:'id',clientSecret:'secret',accessToken:'token',userId:123,expiresAt:NOW+3600_000},signal(),false);
  assert.equal(result.observations.length,1);assert.equal(result.observations[0].category,'heart_rate');assert.equal(result.profile,undefined);assert.equal(urls.some(x=>x.includes('physical-info')),false);assert.ok(urls.some(x=>x.includes('route=false')));
});
