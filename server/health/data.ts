import { createHash } from 'node:crypto';
import { z } from 'zod';

export const RETENTION = 168 * 60 * 60 * 1000;
export const categories = ['sleep','activity','heart_rate','recovery','exercise'] as const;
export type Category = typeof categories[number];
const scalar = z.union([z.string().max(100),z.number().finite(),z.boolean()]);
export const observationSchema = z.object({id:z.string().length(64),category:z.enum(categories),
  source:z.literal('Polar'), measured_at:z.string().nullable(), source_local_date:z.string().optional(),
  retention_anchor:z.number().finite(), time_basis:z.enum(['source_offset','local_date_earliest_bound']),
  retrieved_at:z.string(), values:z.record(z.string().max(50),scalar),
  samples:z.array(z.object({time:z.string().max(40),value:z.number().finite()})).max(2500).optional()}).strict();
export type Observation = z.infer<typeof observationSchema>;
export const profileSchema = z.object({source:z.literal('Polar'),kind:z.literal('registered_profile'),
  height_cm:z.number().positive().max(300).optional(),weight_kg:z.number().positive().max(1000).optional(),
  date_of_birth:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weight_source:z.enum(['SOURCE_UNKNOWN','SOURCE_MEASURED','SOURCE_USER','SOURCE_DERIVED','SOURCE_ESTIMATED']).optional(),
  profile_modified_at:z.string().optional(),retrieved_at:z.string()}).strict();
export type Profile = z.infer<typeof profileSchema>;
const object = (v:unknown): Record<string,unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const list = (v:unknown) => Array.isArray(v) ? v.slice(0,500) : [];
const date = (v:unknown): string | undefined => {
  if(typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))return;
  const parsed=Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===v?v:undefined;
};
function instant(v:unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return;
  const t=Date.parse(v); return Number.isFinite(t) ? t : undefined;
}
function localBound(day:string) { return Date.parse(`${day}T00:00:00Z`) - 14 * 3600_000; }
export function normalizeProfile(raw:unknown,now:number): Profile {
  const r=object(raw), p:Profile={source:'Polar',kind:'registered_profile',retrieved_at:new Date(now).toISOString()};
  if (typeof r.height==='number' && r.height>0 && r.height<=300) p.height_cm=r.height;
  if (typeof r.weight==='number' && r.weight>0 && r.weight<=1000) p.weight_kg=r.weight;
  if (date(r.birthday) && String(r.birthday)<=new Date(now).toISOString().slice(0,10)) p.date_of_birth=String(r.birthday);
  if (['SOURCE_UNKNOWN','SOURCE_MEASURED','SOURCE_USER','SOURCE_DERIVED','SOURCE_ESTIMATED'].includes(String(r.weight_source))) p.weight_source=r.weight_source as Profile['weight_source'];
  if (instant(r.modified)!==undefined) p.profile_modified_at=String(r.modified);
  if (p.height_cm===undefined && p.weight_kg===undefined && !p.date_of_birth) throw new Error('HEALTH_PROFILE_UNAVAILABLE');
  return profileSchema.parse(p);
}

/** Allowlist only agreed fields. Never persist raw API envelopes or provider IDs. */
export function normalize(category:Category,raw:unknown,now:number): Observation[] {
  const envelope=object(raw);
  // The range endpoint wraps days in heart_rates; the single-day response is
  // a day object. Preserve both forms and the existing array compatibility.
  const heartRateRows=Array.isArray(raw)?raw:Object.hasOwn(envelope,'heart_rates')?envelope.heart_rates:[raw];
  const rows=list(category==='sleep' ? envelope.nights : category==='recovery' ? envelope.recharges : category==='heart_rate' ? heartRateRows : raw);
  const result:Observation[]=[];
  for (const item of rows) {
    const r=object(item), values:Record<string,string|number|boolean>={};
    let at:number|undefined, day=date(r.date), samples:Observation['samples'];
    const numbers=(keys:string[])=>{for(const k of keys)if(typeof r[k]==='number' && Number.isFinite(r[k]) && Math.abs(r[k] as number)<1e8) values[k]=r[k] as number;};
    const strings=(keys:string[])=>{for(const k of keys)if(typeof r[k]==='string' && /^[\w:.+\- ]{1,80}$/.test(r[k] as string)) values[k]=r[k] as string;};
    if(category==='sleep') {
      at=instant(r.sleep_start_time);
      const end=instant(r.sleep_end_time);
      if(at===undefined || end===undefined || end<at || end>now) continue;
      values.sleep_start_time=String(r.sleep_start_time);values.sleep_end_time=String(r.sleep_end_time);
      values.interval_seconds=(end-at)/1000;
      numbers(['light_sleep','deep_sleep','rem_sleep','unrecognized_sleep_stage','sleep_score','sleep_charge','total_interruption_duration','short_interruption_duration','long_interruption_duration','continuity','continuity_class','sleep_cycles']);
    } else if(category==='activity') {
      day=date(typeof r.start_time==='string' ? r.start_time.slice(0,10) : undefined);
      at=instant(r.start_time); strings(['active_duration','inactive_duration']); numbers(['steps','daily_activity']);
      const rawZones=object(object(r.samples).activity_zones).samples;
      const zones=Array.isArray(rawZones)?rawZones.slice(0,2500):[];
      const counts:Record<string,number>={};
      for(const s of zones) {const zone=object(s).zone;if(typeof zone==='string'&&['SEDENTARY','LIGHT','MODERATE','VIGOROUS','NON_WEAR','SLEEP'].includes(zone)) counts[zone]=(counts[zone]??0)+1;}
      for(const [k,v] of Object.entries(counts))values[`zone_samples_${k.toLowerCase()}`]=v;
    } else if(category==='heart_rate') {
      samples=(Array.isArray(r.heart_rate_samples)?r.heart_rate_samples.slice(0,2500):[]).map(s=>object(s)).filter(s=>typeof s.heart_rate==='number'&&s.heart_rate>0&&s.heart_rate<300&&typeof s.sample_time==='string'&&/^\d{2}:\d{2}:\d{2}$/.test(s.sample_time))
        .map(s=>({time:String(s.sample_time),value:Number(s.heart_rate)}));
      if(!samples.length)continue;
    } else if(category==='recovery') {
      numbers(['heart_rate_avg','heart_rate_variability_avg','breathing_rate_avg','nightly_recharge_status','ans_charge','ans_charge_status']);
    } else {
      if(typeof r.start_time==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(r.start_time) && typeof r.start_time_utc_offset==='number' && Number.isInteger(r.start_time_utc_offset) && Math.abs(r.start_time_utc_offset)<=840)
        at=Date.parse(`${r.start_time}Z`)-r.start_time_utc_offset*60_000;
      else at=instant(r.start_time);
      strings(['sport','detailed_sport_info','duration']);
      const hr=object(r.heart_rate);
      for(const k of ['average','maximum'])if(typeof hr[k]==='number' && Number(hr[k])>0 && Number(hr[k])<300)values[`heart_rate_${k}`]=Number(hr[k]);
    }
    // API dates without offsets are not UTC or the Mac's timezone. Retain no
    // longer than the earliest possible measurement bound (UTC+14).
    const anchor=at??(day?localBound(day):NaN);
    if(!Number.isFinite(anchor)||anchor<=now-RETENTION||anchor>now||(!Object.keys(values).length&&!samples?.length))continue;
    const identity=String(r.id??r.date??r.start_time??r.sleep_start_time??anchor);
    const id=createHash('sha256').update(`${category}:${identity}`).digest('hex');
    result.push(observationSchema.parse({id,category,source:'Polar',measured_at:at===undefined?null:new Date(at).toISOString(),
      ...(day?{source_local_date:day}:{}),retention_anchor:anchor,time_basis:at===undefined?'local_date_earliest_bound':'source_offset',
      retrieved_at:new Date(now).toISOString(),values,...(samples?{samples}:{})}));
  }
  return result;
}
