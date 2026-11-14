import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize, observationSchema, RETENTION} from '../server/health/data.ts';
import {normalizeHeartRates, readHeartRateSummary, storeHeartRateSummary, summarizeHeartRates} from '../server/health/heart-rate.ts';

const NOW=Date.parse('2026-11-14T12:00:00Z');
const clock=(seconds:number)=>new Date(seconds*1000).toISOString().slice(11,19);

test('heart-rate summaries include late extrema after 2500 samples and retain the complete returned span',()=>{
  const raw=Array.from({length:6000},(_,i)=>({sample_time:clock(i*14),heart_rate:i===5998?180:i===5000?45:70}));
  const [row]=normalize('heart_rate',{heart_rates:[{date:'2026-11-14',heart_rate_samples:raw}]},NOW);
  const summary=readHeartRateSummary(row.values)!;
  assert.equal(summary.basis,'all_valid_returned_samples');
  assert.equal(summary.sample_count,6000);assert.equal(summary.min_bpm,45);assert.equal(summary.max_bpm,180);
  assert.equal(summary.sample_mean_bpm,(5998*70+45+180)/6000);
  assert.deepEqual(summary.first,{time:'00:00:00',value:70});assert.deepEqual(summary.last,{time:clock(5999*14),value:70});
  assert.equal(summary.hourly.length,24);assert.equal(summary.hourly.at(-1)!.max_bpm,180);
  assert.equal(summary.hourly.reduce((sum,h)=>sum+h.sample_count,0),6000);
  assert.equal(row.samples!.length,96);assert.deepEqual(row.samples![0],summary.first);assert.deepEqual(row.samples!.at(-1),summary.last);
  assert.equal(new Set(row.samples!.map(s=>s.time.slice(0,2))).size,24);
  assert.equal(row.measured_at,null);assert.equal(row.time_basis,'local_date_earliest_bound');
  assert.equal(row.retention_anchor,Date.parse('2026-11-13T10:00:00Z'));
  // Rollback builds use this same v1 shape/scalar contract; no new root field.
  assert.deepEqual(Object.keys(row).sort(),['id','category','source','measured_at','source_local_date','retention_anchor','time_basis','retrieved_at','values','samples'].sort());
  assert.equal(observationSchema.safeParse(row).success,true);
  assert.equal(normalize('heart_rate',[{date:'2026-11-14',heart_rate_samples:raw}],row.retention_anchor+RETENTION).length,0);
});

test('unsorted heart-rate clocks, sparse hours and invalid values do not invent continuous coverage',()=>{
  const result=normalizeHeartRates([
    {sample_time:'20:00:00',heart_rate:100},{sample_time:'08:05:00',heart_rate:80},
    {sample_time:'08:00:00',heart_rate:60},{sample_time:'99:00:00',heart_rate:60},
    {sample_time:'08:60:00',heart_rate:60},{sample_time:'08:00:60',heart_rate:60},
    {sample_time:'08:00:00',heart_rate:Infinity},{sample_time:'08:00:00',heart_rate:0},
    {sample_time:'08:00:00',heart_rate:300},null,{sample_time:'instructions',heart_rate:70},
  ])!;
  assert.equal(result.summary.sample_count,3);assert.equal(result.summary.rejected_sample_count,8);
  assert.equal(result.summary.largest_sample_gap_seconds,11*3600+55*60);
  assert.deepEqual(result.summary.hourly.map(h=>h.hour),[8,20]);
  assert.equal(result.summary.hourly[0].sample_mean_bpm,70);assert.equal(result.summary.hourly[1].largest_sample_gap_seconds,0);
  assert.deepEqual(result.samples.map(s=>s.time),['08:00:00','08:05:00','20:00:00']);
  assert.deepEqual(readHeartRateSummary(storeHeartRateSummary(result.summary)),result.summary);
});

test('legacy heart-rate records remain explicitly partial and malformed stored summary cannot claim full input',()=>{
  const legacy=summarizeHeartRates([{time:'02:00:00',value:65}],'legacy_stored_samples',null)!;
  assert.equal(legacy.summary.basis,'legacy_stored_samples');assert.equal(legacy.summary.rejected_sample_count,null);
  assert.deepEqual(legacy.summary.first,legacy.summary.last);assert.equal(legacy.summary.largest_sample_gap_seconds,0);
  assert.equal(readHeartRateSummary({hr_summary_version:1,hr_summary_basis:'all_valid_returned_samples'}),undefined);
  assert.equal(normalizeHeartRates([]),undefined);assert.equal(normalizeHeartRates([{sample_time:'24:00:00',heart_rate:60}]),undefined);
});
