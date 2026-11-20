import { z } from 'zod';
import { ToolRejection } from '../tool-response.ts';
import { RETENTION, type Observation } from './data.ts';
import { readHeartRateSummary, summarizeHeartRates } from './heart-rate.ts';
import type { PhoneTimeRead } from '../history/phone-time.ts';

const sleep = ['sleep_start_time','sleep_end_time','interval_seconds','light_sleep','deep_sleep','rem_sleep',
  'unrecognized_sleep_stage','sleep_score','sleep_charge','total_interruption_duration','short_interruption_duration',
  'long_interruption_duration','continuity','continuity_class','sleep_cycles'] as const;
const activity = ['steps','activity_goal_completion_percent','active_duration','inactive_duration','activity_zone_samples',
  'activity_zone_sample_count','zone_samples_sleep','zone_samples_sedentary','zone_samples_light','zone_samples_moderate','zone_samples_vigorous'] as const;
const recovery = ['heart_rate_avg','heart_rate_variability_avg','breathing_rate_avg','nightly_recharge_status','ans_charge','ans_charge_status'] as const;
const exercise = ['sport','detailed_sport_info','duration','heart_rate_average','heart_rate_maximum'] as const;
const heartRate = ['heart_rate_summary','samples'] as const;
export const polarHistoryFields = [...sleep, ...activity, ...recovery, ...exercise, ...heartRate] as const;
type Field = typeof polarHistoryFields[number];
const groups: Record<Observation['category'], readonly Field[]> = {sleep, activity, recovery, exercise, heart_rate:heartRate};
const units: Record<Field,string> = {
  sleep_start_time:'source timestamp',sleep_end_time:'source timestamp',interval_seconds:'s (derived from source endpoints)',
  light_sleep:'s',deep_sleep:'s',rem_sleep:'s',unrecognized_sleep_stage:'s',sleep_score:'Polar sleep score',sleep_charge:'Polar rating',
  total_interruption_duration:'s',short_interruption_duration:'s',long_interruption_duration:'s',continuity:'Polar score',
  continuity_class:'Polar classification',sleep_cycles:'cycles',steps:'steps',activity_goal_completion_percent:'% of daily activity goal',
  active_duration:'ISO 8601 duration',inactive_duration:'ISO 8601 duration',activity_zone_samples:'source timestamps and Polar activity classes',
  activity_zone_sample_count:'samples',zone_samples_sleep:'samples',zone_samples_sedentary:'samples',zone_samples_light:'samples',
  zone_samples_moderate:'samples',zone_samples_vigorous:'samples',heart_rate_avg:'bpm',heart_rate_variability_avg:'ms',
  breathing_rate_avg:'breaths/min',nightly_recharge_status:'Polar rating',ans_charge:'Polar score',ans_charge_status:'Polar rating',
  sport:'Polar sport',detailed_sport_info:'Polar sport',duration:'ISO 8601 duration',heart_rate_average:'bpm',heart_rate_maximum:'bpm',
  heart_rate_summary:'bpm; gaps in seconds, observed sample counts',samples:'bpm at device-local times',
};
const instant = z.string().datetime({offset:true});
const querySchema = z.object({start_at:instant,end_at:instant, fields:z.array(z.enum(polarHistoryFields)).min(1).max(polarHistoryFields.length),
  limit:z.number().int().min(1).max(80)}).strict().refine(query => {
  const width=Date.parse(query.end_at)-Date.parse(query.start_at);
  return width>0 && width<=RETENTION && new Set(query.fields).size===query.fields.length;
});
export type PolarHistoryQuery = z.infer<typeof querySchema>;
export type PolarHistoryInput = {start_at:string;end_at:string;fields:readonly string[];limit:number} | {cursor:string};
export function parsePolarHistoryQuery(input: PolarHistoryInput) {
  const parsed=querySchema.safeParse(input);
  if (!parsed.success) throw new ToolRejection('invalid_arguments','Select known Polar fields in a positive interval of at most seven days.');
  return {...parsed.data,start_at:new Date(Date.parse(parsed.data.start_at)).toISOString(),end_at:new Date(Date.parse(parsed.data.end_at)).toISOString()};
}

export function projectHeartRates(row: Observation) {
  const stored = readHeartRateSummary(row.values);
  const legacy = stored ? undefined : summarizeHeartRates(row.samples ?? [], 'legacy_stored_samples', null);
  return {summary: stored ?? legacy?.summary, samples: legacy?.samples ?? row.samples ?? []};
}

function sourceDay(row: Observation) {
  return row.time_basis==='local_date_earliest_bound' || (row.category==='activity' && !!row.source_local_date);
}
function timeMatch(row: Observation, start: number, end: number) {
  // Daily aggregates describe the whole source day even when its start was
  // reported with an offset. Older normalized records keep only its UTC instant.
  if (sourceDay(row)) {
    if (!row.source_local_date) return false;
    const midnight = Date.parse(row.source_local_date+'T00:00:00Z');
    return midnight-14*3600_000 < end && midnight+36*3600_000 > start;
  }
  if (!row.measured_at) return false;
  const measured=Date.parse(row.measured_at);
  if (row.category==='sleep' && typeof row.values.sleep_end_time==='string') {
    const until=Date.parse(row.values.sleep_end_time);
    if (until>measured) return measured<end && until>start;
  }
  return measured>=start && measured<end;
}

function sampleMatches(time: string, date: string | undefined, start: number, end: number) {
  const timestamp = time.includes('T') ? time : `${date}T${time}`;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    const measured=Date.parse(timestamp);
    return measured>=start && measured<end;
  }
  const wall=Date.parse(timestamp+'Z');
  return wall-14*3600_000<end && wall+12*3600_000>=start;
}

function renderEntry(row: Observation, fields: Field[], start: number, end: number) {
  const values: Record<string,unknown>={}, missing: Field[]=[];
  let detailCoverage: {scope:string;stored_samples:number;possible_or_exact_matches:number;returned_samples:number;reduced:boolean;
    selection:string} | undefined;
  const heart = row.category==='heart_rate' ? projectHeartRates(row) : undefined;
  for (const field of fields) {
    let value: unknown;
    if (field==='activity_goal_completion_percent') value=row.values.daily_activity;
    else if (field==='heart_rate_summary') value=heart?.summary;
    else if (field==='samples' || field==='activity_zone_samples') {
      const samples=field==='samples'?row.samples?.filter(sample=>/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(sample.time) && sample.value>0 && sample.value<300):row.activity_zone_samples;
      if (samples) {
        const selected=samples.filter(sample=>sampleMatches(sample.time,row.source_local_date,start,end));
        const count=Math.min(96,selected.length);
        value=count===selected.length?selected:Array.from({length:count},(_,i)=>selected[Math.floor(i*(selected.length-1)/(count-1))]);
        detailCoverage={scope:field==='samples'?'bounded stored device-clock samples':'dated provider activity samples',
          stored_samples:(field==='samples'?row.samples:row.activity_zone_samples)?.length ?? 0,possible_or_exact_matches:selected.length,
          returned_samples:count,reduced:count<selected.length || (field==='samples' ? (heart?.summary?.sample_count ?? 0)>samples.length : row.values.activity_zone_samples_reduced===true),
          selection:'Offset timestamps fall within the requested interval. Offset-free samples can overlap under a source offset between UTC−12 and UTC+14; their actual UTC instants are unknown.'};
      }
    } else value=row.values[field];
    if (value===undefined) missing.push(field); else values[field]=value;
  }
  const activityZones = row.category==='activity' && fields.some(field=>field.includes('zone_sample'));
  return {id:row.id,category:row.category,measured_at:row.measured_at,source_local_date:row.source_local_date??null,
    retrieved_at:row.retrieved_at,time_basis:row.time_basis,
    temporal_scope:sourceDay(row)?'whole_source_day_possibly_overlapping_window':row.category==='sleep'?'source_sleep_interval':'recorded_start_in_window',
    ...(row.category==='sleep' && typeof row.values.sleep_end_time==='string'?{interval_end_at:row.values.sleep_end_time}:{}),
    fields:values,missing_fields:missing,
    ...(activityZones?{activity_zone_coverage:row.activity_zone_samples?'counts_of_returned_source_samples; continuity unknown':'legacy_count_only_subset_unknown'}:{}),
    ...(detailCoverage?{sample_coverage:detailCoverage}:{})};
}

export function needsPhoneClock(entry: ReturnType<typeof renderEntry>) {
  if (entry.category==='heart_rate') return 'heart_rate_summary' in entry.fields || (Array.isArray(entry.fields.samples) && entry.fields.samples.length>0);
  const samples=entry.fields.activity_zone_samples;
  return Array.isArray(samples) && samples.some(sample=>typeof sample.time==='string' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(sample.time));
}

export function selectPolarHistory(observations: Observation[], query: PolarHistoryQuery, offset: number) {
  const start=Date.parse(query.start_at), end=Date.parse(query.end_at);
  const selectedFields = new Map(Object.entries(groups).map(([category, group])=>[category, query.fields.filter(field=>group.includes(field))]));
  const matches=observations.filter(row=>selectedFields.get(row.category)!.length && timeMatch(row,start,end))
    .sort((a,b)=>b.retention_anchor-a.retention_anchor || a.id.localeCompare(b.id));
  const entries: ReturnType<typeof renderEntry>[]=[];
  let bytes=0;
  for (const row of matches.slice(offset,offset+query.limit)) {
    const entry=renderEntry(row,selectedFields.get(row.category)!,start,end);
    const size=Buffer.byteLength(JSON.stringify(entry))+1;
    if (bytes+size>32*1024) {
      if (!entries.length) throw new ToolRejection('history_page_too_large','Narrow the Polar field selection for this record.');
      break;
    }
    entries.push(entry);bytes+=size;
  }
  const nextOffset=offset+entries.length;
  return {entries, nextOffset:nextOffset<matches.length?nextOffset:null,
    // Counts and remaining pages also depend on retained rows outside this page.
    earliestExpiry:matches.reduce((expiry,row)=>Math.min(expiry,row.retention_anchor+RETENTION),Infinity),
    coverage:{matching_retained_records:matches.length,returned_records:entries.length,remaining_records:matches.length-nextOffset,
      retention_hours:168,completeness:'unknown',date_only_selection:'Daily totals and heart-rate summaries cover their source record. Partial window overlap does not apportion samples or daily totals to specific hours.'},
    units:Object.fromEntries(query.fields.map(field=>[field,units[field]]))};
}

// Daily references retain their source and uncertainty, without repeating up to
// 96 detailed phone spans per read or exposing any coordinates.
export function polarClockReferences(read: PhoneTimeRead) {
  const evidence=read.evidence;
  if (!('by_source_date' in evidence)) return {status:evidence.status};
  return {status:evidence.status,source:evidence.source, basis:'record_date_phone_timezone',
    meaning:'Phone offsets are interpretation evidence; original Polar timestamps remain unchanged and device synchronization is unknown.',
    by_source_date:evidence.by_source_date.map(day=>({source_local_date:day.source_local_date,
      status:day.reference.status,utc_offset_minutes:day.reference.utc_offset_minutes,observation_count:day.reference.observation_count}))};
}
