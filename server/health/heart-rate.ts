import { z } from 'zod';

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
const bpm = z.number().finite().positive().lt(300);
const sampleSchema = z.object({time:clock,value:bpm}).strict();
export type HeartRateSample = z.infer<typeof sampleSchema>;
const statisticsSchema = z.object({
  sample_count:z.number().int().positive(), first:sampleSchema, last:sampleSchema,
  min_bpm:bpm, max_bpm:bpm, sample_mean_bpm:bpm,
  largest_sample_gap_seconds:z.number().int().min(0).max(86399),
}).strict();
export const heartRateSummarySchema = statisticsSchema.extend({
  basis:z.enum(['all_valid_returned_samples','legacy_stored_samples']),
  rejected_sample_count:z.number().int().nonnegative().nullable(),
  hourly:z.array(statisticsSchema.extend({hour:z.number().int().min(0).max(23)}).strict()).max(24),
}).strict();
export type HeartRateSummary = z.infer<typeof heartRateSummarySchema>;
const seconds = (time:string) => Number(time.slice(0,2))*3600+Number(time.slice(3,5))*60+Number(time.slice(6,8));

function statistics(samples:HeartRateSample[]) {
  let min=Infinity,max=-Infinity,sum=0,gap=0;
  for(let i=0;i<samples.length;i++) {
    const s=samples[i];min=Math.min(min,s.value);max=Math.max(max,s.value);sum+=s.value;
    if(i)gap=Math.max(gap,seconds(s.time)-seconds(samples[i-1].time));
  }
  return {sample_count:samples.length,first:samples[0],last:samples.at(-1)!,
    min_bpm:min,max_bpm:max,sample_mean_bpm:sum/samples.length,largest_sample_gap_seconds:gap};
}

/** Spread the bounded detail over the returned span, preserving both endpoints. */
export function representativeHeartRates(sorted:HeartRateSample[]):HeartRateSample[] {
  if(sorted.length<=96)return sorted;
  return Array.from({length:96},(_,i)=>sorted[Math.floor(i*(sorted.length-1)/95)]);
}

export function summarizeHeartRates(samples:HeartRateSample[],basis:HeartRateSummary['basis'],rejected:number|null) {
  const sorted=samples.filter(s=>sampleSchema.safeParse(s).success).sort((a,b)=>a.time.localeCompare(b.time));
  if(!sorted.length)return;
  const hours=new Map<number,HeartRateSample[]>();
  for(const s of sorted){const hour=Number(s.time.slice(0,2));const bucket=hours.get(hour)??[];bucket.push(s);hours.set(hour,bucket);}
  const summary:HeartRateSummary={...statistics(sorted),basis,rejected_sample_count:rejected,
    hourly:[...hours].map(([hour,bucket])=>({hour,...statistics(bucket)}))};
  return {summary,samples:representativeHeartRates(sorted)};
}

/** Summarize before reducing: the HTTP layer already bounds the API response. */
export function normalizeHeartRates(raw:unknown) {
  if(!Array.isArray(raw))return;
  const samples:HeartRateSample[]=[];
  for(const item of raw) {
    if(!item||typeof item!=='object')continue;
    const parsed=sampleSchema.safeParse({time:item.sample_time,value:item.heart_rate});
    if(parsed.success)samples.push(parsed.data);
  }
  return summarizeHeartRates(samples,'all_valid_returned_samples',raw.length-samples.length);
}

// Keep the existing encrypted v1 observation shape readable by rollback builds.
// Its allowlisted scalar values hold the bounded statistics, not another file.
type Values = Record<string,string|number|boolean>;
const statisticFields=['sample_count','min_bpm','max_bpm','sample_mean_bpm','largest_sample_gap_seconds'] as const;
export function storeHeartRateSummary(summary:HeartRateSummary):Values {
  const values:Values={hr_summary_version:1,hr_summary_basis:summary.basis};
  if(summary.rejected_sample_count!==null)values.hr_rejected_sample_count=summary.rejected_sample_count;
  const put=(prefix:string,s:z.infer<typeof statisticsSchema>)=>{
    for(const key of statisticFields)values[prefix+key]=s[key];
    values[prefix+'first_time']=s.first.time;values[prefix+'first_bpm']=s.first.value;
    values[prefix+'last_time']=s.last.time;values[prefix+'last_bpm']=s.last.value;
  };
  put('hr_',summary);
  for(const hour of summary.hourly)put(`hr_${String(hour.hour).padStart(2,'0')}_`,hour);
  return values;
}
export function readHeartRateSummary(values:Values):HeartRateSummary|undefined {
  if(values.hr_summary_version!==1)return;
  const get=(prefix:string)=>({...Object.fromEntries(statisticFields.map(k=>[k,values[prefix+k]])),
    first:{time:values[prefix+'first_time'],value:values[prefix+'first_bpm']},
    last:{time:values[prefix+'last_time'],value:values[prefix+'last_bpm']}});
  const hourly=[];
  for(let hour=0;hour<24;hour++) {
    const prefix=`hr_${String(hour).padStart(2,'0')}_`;
    if(values[prefix+'sample_count']!==undefined)hourly.push({hour,...get(prefix)});
  }
  const result=heartRateSummarySchema.safeParse({...get('hr_'),basis:values.hr_summary_basis,
    rejected_sample_count:values.hr_rejected_sample_count??null,hourly});
  return result.success?result.data:undefined;
}

export const heartRateGuidance = {
  unit:'bpm', time_basis:'source_device_clock', utc_offset_minutes:null,
  phone_time:'phone_time_evidence in this same result projects existing consented phone-history uploads for the returned source dates. Use its dated timezone/offset spans as candidate correspondence when useful, preserving gaps and multiple candidates. This is phone runtime evidence, not a verified Polar offset. Unavailable or empty evidence is normal; do not request new sharing merely to fill it.',
  samples:'Polar continuous-heart-rate samples are period averages, not instantaneous readings. Samples are spread across the available time-ordered record; summaries are computed before reduction.',
  summary:'all_valid_returned_samples covers every valid sample in that API day response, not necessarily the entire day. legacy_stored_samples may omit later measurements. Hourly entries cover only their first/last samples; absent hours and gaps are not interpolated. sample_mean_bpm is an unweighted sample mean, not a time-weighted or resting heart rate.',
  time:'Use source_local_date and device clock times as supplied. The API supplies no UTC offset here; do not infer it from the Mac, phone location or retrieval time. Do not describe the latest recorded point as current heart rate.',
  correlation:'A missing UTC offset does not erase the recorded local hour. Answer source-clock questions using that date/hour. For conversation events, distinguish an established clock correspondence from a contextual association: dated phone timezone evidence or a clear same-local-clock conversation can support a qualified association, but does not prove the Polar clock setting. Use already permitted context only when useful; do not require location/history sharing. Never silently assign an offset, rewrite measurement timestamps, or claim exact UTC alignment from these hints. Travel, clock changes and missing synchronization evidence can make an association ambiguous. If the distinction changes the answer, briefly explain it or ask one necessary question; otherwise use the useful supported observation without a routine caveat.',
  period:'The requested hours select device-local dates that may overlap that interval. Returned days are not clipped to exact UTC hours; a day can include samples outside the requested interval. First/last describe the observed span, not uninterrupted coverage.',
  conversation:'Use heart rate only when it helps the current conversation or a worthwhile autonomous action. Select useful changes or numbers; do not routinely recite coverage, gaps or limitations. Explain a limitation briefly only when it changes the answer. Do not infer stress, fatigue, emotion, illness or a cause from heart rate alone. Compare days only over comparable observed periods; silence is valid.',
} as const;
