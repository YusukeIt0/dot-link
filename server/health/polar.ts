import { z } from 'zod';
import { normalize, normalizeProfile, type Observation, type Profile, RETENTION } from './data.ts';

export const POLAR_REDIRECT = 'http://localhost:3464/polar/callback';
export const connectionSchema=z.object({clientId:z.string().min(1).max(256),clientSecret:z.string().min(1).max(512),
  accessToken:z.string().min(1).max(4096).optional(),userId:z.number().int().positive().optional(),expiresAt:z.number().finite().optional()}).strict();
export type PolarConnection=z.infer<typeof connectionSchema>;
export class PolarError extends Error {
  readonly code:string;
  constructor(code:string) {super(code);this.code=code;}
}
export class PolarAPI {
  private fetcher:typeof fetch;
  private now:()=>number;
  private retryAt=0;
  constructor(options:{fetch?:typeof fetch;now?:()=>number}={}) {this.fetcher=options.fetch??fetch;this.now=options.now??Date.now;}
  private async request(url:string,init:RequestInit,signal?:AbortSignal,empty=false):Promise<unknown> {
    if(this.now()<this.retryAt)throw new PolarError('HEALTH_RATE_LIMITED');
    let r:Response;
    try {r=await this.fetcher(url,{...init,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])])});}
    catch {throw new PolarError('HEALTH_NETWORK_UNAVAILABLE');}
    if(r.status===429) {const delay=Number(r.headers.get('retry-after'));this.retryAt=this.now()+Math.min(86_400_000,Math.max(60_000,Number.isFinite(delay)?delay*1000:900_000));await r.body?.cancel();throw new PolarError('HEALTH_RATE_LIMITED');}
    if(r.status===401||r.status===403){await r.body?.cancel();throw new PolarError('HEALTH_RECONNECT_REQUIRED');}
    if(r.status===204 || (empty&&r.status===404)){await r.body?.cancel();return undefined;}
    if(r.status===409){await r.body?.cancel();throw new PolarError('HEALTH_ALREADY_REGISTERED');}
    if(!r.ok){await r.body?.cancel();throw new PolarError('HEALTH_REQUEST_FAILED');}
    if(!r.body)return undefined;
    const chunks:Uint8Array[]=[];let size=0;
    try {for await(const bytes of r.body as unknown as AsyncIterable<Uint8Array>){size+=bytes.length;if(size>4*1024*1024)throw new Error();chunks.push(bytes);}return size?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;}
    catch {throw new PolarError('HEALTH_INVALID_RESPONSE');}
  }
  authorization(clientId:string,state:string) {
    const url=new URL('https://flow.polar.com/oauth2/authorization');
    url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:POLAR_REDIRECT,scope:'accesslink.read_all',state}).toString();return url.href;
  }
  async exchange(client:PolarConnection,code:string,signal:AbortSignal):Promise<PolarConnection> {
    // Authorization codes are single-use. Never automatically replay this POST.
    const raw=await this.request('https://polarremote.com/v2/oauth2/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`},
      body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:POLAR_REDIRECT})},signal);
    const token=z.object({access_token:z.string().min(1).max(4096),token_type:z.string(),expires_in:z.number().positive().max(10*365*86400),'x_user_id':z.number().int().positive()}).parse(raw);
    if(token.token_type.toLowerCase()!=='bearer')throw new PolarError('HEALTH_INVALID_RESPONSE');
    const connection={...client,accessToken:token.access_token,userId:token.x_user_id,expiresAt:this.now()+token.expires_in*1000};
    // Registration is required. 409 can mean already registered to this client;
    // verify by reading that exact user instead of accepting it blindly.
    try {await this.call(connection,'/users',{method:'POST',body:JSON.stringify({'member-id':`dot-link-${token.x_user_id}`})},signal);}
    catch(e) {if(!(e instanceof PolarError)||e.code!=='HEALTH_ALREADY_REGISTERED')throw e;await this.call(connection,`/users/${token.x_user_id}`,{},signal);}
    return connection;
  }
  private call(c:PolarConnection,path:string,init:RequestInit={},signal?:AbortSignal,empty=false) {
    if(!c.accessToken||!c.expiresAt||c.expiresAt<=this.now())throw new PolarError('HEALTH_RECONNECT_REQUIRED');
    return this.request(`https://www.polaraccesslink.com/v3${path}`,{...init,headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${c.accessToken}`}},signal,empty);
  }
  async profile(c:PolarConnection,signal:AbortSignal):Promise<Profile> {return normalizeProfile(await this.call(c,'/users/physical-info',{},signal),this.now());}
  async collect(c:PolarConnection,signal:AbortSignal,includeProfile=true):Promise<{observations:Observation[];profile?:Profile}> {
    const now=this.now(), from=new Date(now-RETENTION).toISOString().slice(0,10),to=new Date(now+14*3600_000).toISOString().slice(0,10);
    const observations:Observation[]=[];
    // Bounded pull; no public webhook receiver or extra cloud service. Empty
    // categories are ordinary gaps, not fabricated observations.
    for(const [category,path] of [
      ['sleep','/users/sleep'],['activity',`/users/activities?from=${from}&to=${to}&activity_zones=true`],
      ['heart_rate',`/users/continuous-heart-rate?from=${from}&to=${to}`],
      ['recovery','/users/nightly-recharge'],['exercise','/exercises?samples=false&zones=false&route=false'],
    ] as const) {const raw=await this.call(c,path,{},signal,true);if(raw)observations.push(...normalize(category,raw,now));}
    let profile:Profile|undefined;
    if(includeProfile)try{profile=await this.profile(c,signal);}catch(error){
      // Optional profile gaps must not discard already fetched measurements.
      // Revoked authorization and cancellation still fence the entire read.
      if(signal.aborted||(error instanceof PolarError&&error.code==='HEALTH_RECONNECT_REQUIRED'))throw error;
    }
    return {observations,profile};
  }
  async disconnect(c:PolarConnection,signal:AbortSignal) {if(c.userId&&c.accessToken)await this.call(c,`/users/${c.userId}`,{method:'DELETE'},signal,true);}
}
