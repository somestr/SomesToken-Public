import {quoteModelUsage, MODEL_COST_PROFILE} from './model-costs.mjs';
import {quotaRoundingUncertainty} from './quota-snapshots.mjs';

const MINUTE=60000, HOUR=60*MINUTE;
export const ACTIVITY_WINDOW_MS=5*MINUTE;
export const RATE_PRICE_REVISION=MODEL_COST_PROFILE.profile_id+':accounting1';
// Version 3 discards calibration trained with assumed provider precision.
const RETENTION=6*HOUR, MAX_GAP=2*MINUTE, MIN_SAMPLES=3, STATE_VERSION=3;
// Total-variation distance is half the absolute difference in profile cost
// shares. A value over 0.25 is materially outside the calibrated composition.
const PROFILE_MIX_TV_TOLERANCE=0.25, MAX_PROFILES=64, MAX_ROWS=100000;
const LABEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const PROFILE=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,339}$/;
const number=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const round=n=>Math.round(n*1e9)/1e9;
const fingerprint=r=>JSON.stringify([r.host,r.task_key,r.source_key,r.observed_at,r.model,r.effort,r.service_tier,r.usage,r.quality,r.validation_status]);
const profile=r=>[r.model,r.effort,r.service_tier,r.usage.input_tokens>272000?'long':'short'].join(':');
const profiles=rows=>[...new Set(rows.map(profile))].sort();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function pricedEvidence(rows) {
  const values=[];
  try {
    for(const r of rows) {
      if(r.host==='claude'||!PROFILE.test(profile(r)))return null;
      const quote=quoteModelUsage({...r.usage,quality:r.quality},
        {model:r.model,service_tier:r.service_tier,at:r.observed_at,single_request:true});
      if(quote?.calculation_quality!=='exact'||!number(quote.calculated_dollar_equivalent))return null;
      values.push([profile(r),quote.calculated_dollar_equivalent]);
    }
  }catch{return null;}
  const cost=values.reduce((n,[,value])=>n+value,0),totals=new Map();
  for(const [key,value] of values)totals.set(key,(totals.get(key)??0)+value);
  const composition=cost>0?[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,value/cost]):[];
  return {cost,composition};
}
export function pricingProfileCostShares(rows) {
  if(!Array.isArray(rows)||rows.length>MAX_ROWS)return null;
  return pricedEvidence(rows)?.composition??null;
}
function validComposition(value,{empty=false}={}) {
  if(!Array.isArray(value)||value.length>MAX_PROFILES||(!empty&&!value.length))return false;
  const keys=new Set();let total=0;
  for(const item of value) {
    if(!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||!PROFILE.test(item[0])||!number(item[1])||item[1]>1||keys.has(item[0]))return false;
    keys.add(item[0]);total+=item[1];
  }
  return empty&&!value.length||Math.abs(total-1)<=1e-6;
}
function aggregateComposition(samples) {
  const totals=new Map();let total=0;
  for(const sample of samples) {
    if(!number(sample.cost)||sample.cost<=0||!validComposition(sample.pricing_profile_cost_shares))return null;
    total+=sample.cost;
    for(const [key,share] of sample.pricing_profile_cost_shares)totals.set(key,(totals.get(key)??0)+sample.cost*share);
  }
  return total>0?[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,value/total]):null;
}
function mixDistance(candidate,reference) {
  if(!validComposition(candidate)||!validComposition(reference))return null;
  const current=new Map(candidate),baseline=new Map(reference);
  if([...current.keys()].some(key=>!baseline.has(key)))return Infinity;
  const keys=new Set([...current.keys(),...baseline.keys()]);
  return [...keys].reduce((sum,key)=>sum+Math.abs((current.get(key)??0)-(baseline.get(key)??0)),0)/2;
}

/** Recorded event volume per wall-clock hour, not generation speed or billing.
 * An empty, healthy interval only establishes no recorded activity. */
export function recentActivity(rows,{now,startedAt,coverage=false,stale=false}={}) {
  const begin=Math.max(startedAt??now,now-ACTIVITY_WINDOW_MS),elapsed=now-begin;
  const map=new Map(),conflicts=new Set();
  for(const r of rows)if(r.observed_at>begin&&r.observed_at<=now) {
    if(map.has(r.record_key)&&fingerprint(map.get(r.record_key))!==fingerprint(r))conflicts.add(r.record_key);
    else map.set(r.record_key,r);
  }
  const selected=[...map.values()].filter(r=>!conflicts.has(r.record_key)),evidence=pricedEvidence(selected);
  const base={status:'unavailable',measurement_basis:'recorded_activity_rate',
    interval_started_at_ms:begin,interval_ended_at_ms:now,duration_ms:elapsed,
    response_count:selected.length,coverage_scope:'local_recorded_responses',
    current_response_unflushed:'unavailable',price_revision:RATE_PRICE_REVISION,
    pricing_profiles:profiles(selected),pricing_profile_cost_shares:evidence?.composition??[],total_tokens_per_hour:null,new_input_tokens_per_hour:null,
    cached_input_tokens_per_hour:null,output_tokens_per_hour:null,cache_write_input_tokens_per_hour:null,
    calculated_dollar_equivalent_per_hour:null,cost_quality:'unavailable'};
  if(stale||!number(elapsed))return {...base,reason_codes:['stale_activity_snapshot']};
  if(elapsed<MINUTE)return {...base,status:'measuring',reason_codes:['insufficient_activity_interval']};
  if(!selected.length&&(!coverage||conflicts.size))return {...base,reason_codes:['activity_coverage_incomplete']};
  const complete=coverage&&!conflicts.size&&selected.every(r=>r.quality==='exact'&&r.validation_status!=='historical_unverified');
  const factor=HOUR/elapsed,cost=evidence?.cost??null;
  const rate=key=>selected.every(r=>number(r.usage[key]))?round(selected.reduce((n,r)=>n+r.usage[key],0)*factor):null;
  return {...base,status:complete?(selected.length?'observed':'quiet'):'partial',
    total_tokens_per_hour:rate('total_tokens'),
    new_input_tokens_per_hour:round(selected.reduce((n,r)=>n+r.usage.input_tokens-r.usage.cached_input_tokens,0)*factor),
    cached_input_tokens_per_hour:rate('cached_input_tokens'),output_tokens_per_hour:rate('output_tokens'),
    cache_write_input_tokens_per_hour:rate('cache_write_input_tokens'),
    calculated_dollar_equivalent_per_hour:cost!==null&&complete?round(cost*factor):null,
    cost_quality:cost!==null&&complete?'exact':'unavailable',
    reason_codes:complete?[]:['activity_coverage_incomplete']};
}

const IDENTITY=['provider','account_id','plan_id','limit_id','quota_group','window_id','identity_basis'];
const validPrecision=value=>value==null||(number(value)&&value<=100);
function quotaPoint(q,now) {
  if(!q||!['codex','claude'].includes(q.provider)||!IDENTITY.every(k=>typeof q[k]==='string'&&LABEL.test(q[k]))
    ||!['host_account_id','host_login_fingerprint'].includes(q.identity_basis)
    ||q.quality!=='exact'||!Number.isSafeInteger(q.snapshot_at_ms)||q.snapshot_at_ms>now||now-q.snapshot_at_ms>MAX_GAP
    ||!Number.isSafeInteger(q.resets_at_ms)||q.resets_at_ms<=now||!number(q.used_percent)||q.used_percent>100
    ||!number(q.window_duration_mins)||q.window_duration_mins<=0
    ||!validPrecision(q.precision_percent))return null;
  return {...Object.fromEntries(IDENTITY.map(k=>[k,q[k]])),snapshot_at_ms:q.snapshot_at_ms,
    resets_at_ms:q.resets_at_ms,window_duration_mins:q.window_duration_mins,used_percent:q.used_percent,precision_percent:q.precision_percent??null};
}
const accountScope=q=>JSON.stringify([...IDENTITY.map(k=>q[k]),q.resets_at_ms,q.window_duration_mins]);
const scope=q=>JSON.stringify([accountScope(q),q.precision_percent]);
function validSavedPoint(point) {
  return point&&['codex','claude'].includes(point.provider)&&IDENTITY.every(k=>typeof point[k]==='string'&&LABEL.test(point[k]))
    &&['host_account_id','host_login_fingerprint'].includes(point.identity_basis)
    &&Number.isSafeInteger(point.snapshot_at_ms)&&Number.isSafeInteger(point.resets_at_ms)
    &&point.resets_at_ms>point.snapshot_at_ms&&number(point.window_duration_mins)&&point.window_duration_mins>0
    &&number(point.used_percent)&&point.used_percent<=100&&validPrecision(point.precision_percent);
}
/** Account counter observation, independent of pricing/calibration. It must
 * never be divided among tasks using token shares, even during local quiet. */
export function accountQuotaChange(before,after) {
  const base={status:'unavailable',scope:'account',measurement_basis:'host_percent_delta',
    observed_change_pp:null,lower_change_pp:null,upper_change_pp:null,task_attribution:'unavailable'};
  if(!validSavedPoint(before)||!validSavedPoint(after))return {...base,reason_codes:['quota_endpoints_missing']};
  if(accountScope(before)!==accountScope(after))return {...base,reason_codes:['quota_scope_changed']};
  if(after.snapshot_at_ms<=before.snapshot_at_ms||after.used_percent<before.used_percent)
    return {...base,reason_codes:['quota_epoch_changed']};
  const delta=after.used_percent-before.used_percent;
  const error=quotaRoundingUncertainty(before.precision_percent,after.precision_percent);
  const knownPrecision=error!==null;
  return {...base,status:delta===0?'counter_unchanged':'observed',
    interval_started_at_ms:before.snapshot_at_ms,interval_ended_at_ms:after.snapshot_at_ms,
    observed_change_pp:round(delta),lower_change_pp:knownPrecision?round(Math.max(0,delta-error)):null,
    upper_change_pp:knownPrecision?round(Math.min(100,delta+error)):null,
    bounds_basis:knownPrecision?'quota_rounding_only_not_confidence_interval':'unavailable',
    reason_codes:[...(!knownPrecision?['quota_precision_unavailable']:[]),
      ...(delta===0?['unchanged_counter_does_not_prove_zero_usage']:[])]};
}
function validSavedSample(sample) {
  return sample&&Number.isSafeInteger(sample.start)&&Number.isSafeInteger(sample.end)&&sample.start<sample.end
    &&number(sample.delta)&&number(sample.cost)&&sample.cost>0&&number(sample.uncertainty)
    &&Array.isArray(sample.pricing_profiles)&&sample.pricing_profiles.length<=MAX_PROFILES
    &&sample.pricing_profiles.every(value=>typeof value==='string'&&PROFILE.test(value))
    &&validComposition(sample.pricing_profile_cost_shares)
    &&same(sample.pricing_profiles,[...sample.pricing_profile_cost_shares.map(([key])=>key)].sort());
}
function savedState(previous) {
  if(previous?.version!==STATE_VERSION||previous.price_revision!==RATE_PRICE_REVISION
    ||!Number.isSafeInteger(previous.observed_at)||!Array.isArray(previous.windows)||previous.windows.length>32)return null;
  const windows=[];
  for(const window of previous.windows) {
    if(!validSavedPoint(window?.latest)||!validSavedPoint(window?.anchor)||scope(window.latest)!==scope(window.anchor)
      ||!Array.isArray(window.samples)||window.samples.length>32||!window.samples.every(validSavedSample)
      ||(window.samples.length&&(!number(window.latest.precision_percent)||!number(window.anchor.precision_percent))))continue;
    windows.push({latest:window.latest,anchor:window.anchor,samples:window.samples});
  }
  return {...previous,windows};
}
function completeHost(scan,host,rows) {
  const inventory=scan.host_inventory_complete?.[host]??(host==='codex'?scan.record_inventory_complete:false);
  const gaps=scan.host_coverage?.[host]??scan.global_coverage_gaps??scan.coverage_gaps??[];
  if(inventory!==true||gaps.length||scan.host_status?.[host]==='unavailable')return false;
  // A missing source has no timestamp, so task-local inventory gaps cannot safely
  // be declared outside the measured interval just because its last row is old.
  if((scan.tasks??[]).some(t=>(t.host??'codex')===host&&(t.coverage_gaps??[]).length))return false;
  return rows.every(r=>r.quality==='exact'&&r.validation_status!=='historical_unverified');
}

/** Prospective, disjoint calibration intervals. Historical quota summaries never
 * train this model. Coefficients remain conditional on local account coverage. */
export function learnQuotaRates(previous,rows,oldRows,quotas,scan,{now}={}) {
  const prior=savedState(previous);
  const activityRows=(Array.isArray(rows)?rows:[]).slice(-MAX_ROWS);
  const gap=prior&&(!number(prior.observed_at)||now-prior.observed_at>MAX_GAP||now<prior.observed_at);
  const points=new Map(),ambiguous=new Set();
  for(const q of quotas) {
    const point=quotaPoint(q,now);if(!point)continue;
    const key=accountScope(point),existing=points.get(key);
    if(existing&&existing.snapshot_at_ms===point.snapshot_at_ms&&!same(existing,point))ambiguous.add(key);
    if(!existing||point.snapshot_at_ms>=existing.snapshot_at_ms)points.set(key,point);
  }
  const old=new Map((Array.isArray(oldRows)?oldRows:[]).slice(-MAX_ROWS).map(r=>[r.record_key,r]));
  const late=[],revised=[];
  for(const current of activityRows) {
    const before=old.get(current.record_key);
    // A reused row is the same object; only a replaced row can differ.
    if(before&&before!==current&&fingerprint(before)!==fingerprint(current))revised.push([before,current]);
    else if(!before&&current.observed_at<=(prior?.observed_at??-1))late.push(current);
  }
  const windows=[],reports=[];
  for(const [key,q] of [...points].slice(0,32)) {
    let priorWindow=prior?.windows?.find(w=>scope(w.latest)===scope(q));
    const accountBefore=prior?.windows?.find(w=>accountScope(w.latest)===accountScope(q))?.latest;
    const accountChange=accountQuotaChange(ambiguous.has(key)?null:accountBefore,q);
    let reason=gap?'capture_gap':null;
    if(ambiguous.has(key))reason='ambiguous_quota_snapshot';
    if(priorWindow&&q.snapshot_at_ms===priorWindow.latest.snapshot_at_ms&&!same(q,priorWindow.latest))reason='ambiguous_quota_snapshot';
    else if(priorWindow&&(q.snapshot_at_ms<priorWindow.latest.snapshot_at_ms||q.used_percent<priorWindow.latest.used_percent))reason='quota_epoch_changed';
    if(!reason&&q.precision_percent===null)reason='quota_precision_unavailable';
    const relevant=activityRows.filter(r=>r.host===q.provider&&r.observed_at>=(priorWindow?.anchor?.snapshot_at_ms??q.snapshot_at_ms)&&r.observed_at<=q.snapshot_at_ms);
    if(!reason&&!completeHost(scan,q.provider,relevant))reason='activity_coverage_incomplete';
    if(priorWindow) {
      const trainedStart=Math.min(priorWindow.anchor.snapshot_at_ms,...priorWindow.samples.map(s=>s.start));
      const trainedEnd=priorWindow.latest.snapshot_at_ms;
      const touches=row=>row.host===q.provider&&row.observed_at>trainedStart&&row.observed_at<=trainedEnd;
      if(late.some(touches)||revised.some(pair=>pair.some(touches)))reason='late_or_revised_activity';
    }
    if(reason)priorWindow=null;
    let anchor=priorWindow?.anchor??q;
    let samples=(priorWindow?.samples??[]).filter(s=>s.start>=now-RETENTION).slice(-32);
    const interval=activityRows.filter(r=>r.host===q.provider&&r.observed_at>anchor.snapshot_at_ms&&r.observed_at<=q.snapshot_at_ms);
    const keys=profiles(interval),evidence=pricedEvidence(interval),cost=evidence?.cost??null;
    const calibratedProfiles=[...new Set(samples.flatMap(s=>s.pricing_profiles))].sort();
    if(interval.length&&evidence===null){reason='activity_price_unavailable';anchor=q;samples=[];}
    else if(keys.some(profile=>!calibratedProfiles.includes(profile))&&samples.length) {
      reason='profile_mix_changed';anchor=q;samples=[];
    } else if(!reason&&q.snapshot_at_ms-anchor.snapshot_at_ms>=MINUTE) {
      const delta=q.used_percent-anchor.used_percent;
      // At least two quantization steps and a strictly positive conservative
      // bound. Endpoint error is bounded, not an empirical confidence interval.
      const uncertainty=(q.precision_percent+anchor.precision_percent)/2;
      if(delta>uncertainty&&delta>=2*uncertainty&&cost>0) {
        const distance=samples.length?mixDistance(evidence.composition,aggregateComposition(samples)):0;
        if(distance===null||distance>PROFILE_MIX_TV_TOLERANCE) {
          reason='profile_mix_changed';samples=[];anchor=q;
        }else{
          samples.push({start:anchor.snapshot_at_ms,end:q.snapshot_at_ms,delta,cost,uncertainty,
            pricing_profiles:keys,pricing_profile_cost_shares:evidence.composition});
          samples=samples.slice(-32);anchor=q;
        }
      }else if(delta>uncertainty&&(!interval.length||cost===0)) {
        reason='unassigned_account_usage';samples=[];anchor=q;
      }else if(q.snapshot_at_ms-anchor.snapshot_at_ms>RETENTION){reason='insufficient_quota_signal';anchor=q;}
    }
    const calibratedComposition=aggregateComposition(samples);
    const entry={latest:q,anchor,samples};windows.push(entry);
    const report={...Object.fromEntries(IDENTITY.map(k=>[k,q[k]])),status:'learning',measurement_basis:'estimated',
      resets_at_ms:q.resets_at_ms,window_duration_mins:q.window_duration_mins,snapshot_at_ms:q.snapshot_at_ms,
      price_revision:RATE_PRICE_REVISION,sample_count:samples.length,minimum_samples:MIN_SAMPLES,
      account_coverage:'local_only_external_usage_unknown',method:'paired_local_activity_quota_change',
      observed_account_change:accountChange,
      per_api_dollar:null,lower_per_api_dollar:null,upper_per_api_dollar:null,
      pricing_profiles:calibratedComposition?.map(([profile])=>profile)??[],
      pricing_profile_cost_shares:calibratedComposition??[],reason_codes:[reason??'insufficient_paired_intervals']};
    if(samples.length>=MIN_SAMPLES&&!reason) {
      const costSum=samples.reduce((n,s)=>n+s.cost,0),delta=samples.reduce((n,s)=>n+s.delta,0),error=samples.reduce((n,s)=>n+s.uncertainty,0);
      const coefficient=delta/costSum;
      const fit=samples.reduce((n,s)=>n+Math.abs(s.delta-s.cost*coefficient),0)/delta;
      if(number(coefficient)&&number(fit)&&fit<=0.35)Object.assign(report,{status:'estimated',reason_codes:[],
        interval_started_at_ms:samples[0].start,interval_ended_at_ms:samples.at(-1).end,
        per_api_dollar:coefficient,lower_per_api_dollar:Math.max(0,(delta-error)/costSum),upper_per_api_dollar:(delta+error)/costSum,
        relative_fit_error:fit,bounds_basis:'quota_rounding_only_not_confidence_interval'});
      else report.reason_codes=['unstable_quota_conversion'];
    }else if(reason)report.status='unavailable';
    reports.push(report);
  }
  return {state:{version:STATE_VERSION,price_revision:RATE_PRICE_REVISION,observed_at:now,windows},reports};
}

export function taskQuotaRates(activity,reports,{host='codex'}={}) {
  const relevant=reports.filter(r=>r.provider===host);
  if(!relevant.length)return [{provider:host,status:'unavailable',measurement_basis:'estimated',estimated_quota_burn_pp_per_hour:null,reason_codes:['provider_quota_unavailable']}];
  return relevant.map(r=>{
    const base={provider:host,limit_id:r.limit_id,quota_group:r.quota_group,window_id:r.window_id,
      window_duration_mins:r.window_duration_mins,resets_at_ms:r.resets_at_ms,snapshot_at_ms:r.snapshot_at_ms,
      status:r.status,measurement_basis:'estimated',sample_count:r.sample_count,minimum_samples:r.minimum_samples,
      account_coverage:r.account_coverage,price_revision:r.price_revision,reason_codes:r.reason_codes,
      observed_account_change:r.observed_account_change,
      estimated_quota_burn_pp_per_hour:null,lower_quota_burn_pp_per_hour:null,upper_quota_burn_pp_per_hour:null};
    if(!['observed','quiet'].includes(activity.status)||activity.cost_quality!=='exact')return {...base,status:'unavailable',reason_codes:['activity_rate_unavailable']};
    if(activity.status==='quiet')return {...base,status:'quiet',reason_codes:['no_recent_recorded_activity']};
    if(r.status!=='estimated')return base;
    if(!activity.pricing_profiles.every(p=>r.pricing_profiles.includes(p)))return {...base,status:'learning',reason_codes:['profile_not_calibrated']};
    const distance=mixDistance(activity.pricing_profile_cost_shares,r.pricing_profile_cost_shares);
    if(distance===null)return {...base,status:'learning',reason_codes:['profile_composition_unavailable']};
    if(distance>PROFILE_MIX_TV_TOLERANCE)return {...base,status:'learning',reason_codes:['profile_mix_changed']};
    const dollars=activity.calculated_dollar_equivalent_per_hour;
    return {...base,status:'estimated',reason_codes:[],
      estimated_quota_burn_pp_per_hour:round(dollars*r.per_api_dollar),
      lower_quota_burn_pp_per_hour:round(dollars*r.lower_per_api_dollar),upper_quota_burn_pp_per_hour:round(dollars*r.upper_per_api_dollar),
      bounds_basis:r.bounds_basis,scenario:'local_activity_represents_account_usage'};
  });
}

/** Request-group prediction, not a whole-project budget. Token count alone
 * cannot be converted: require an independently priced, matching cohort. */
export function taskQuotaForecast(forecast,reports,{host='codex',now}={}) {
  const unavailable=reason=>({status:forecast.status==='learning'?'learning':'unavailable',measurement_basis:'estimated',
    prediction_unit:'request_group',sample_count:forecast.sample_count??0,reason_codes:[reason],estimated_quota_pp:null});
  if(forecast.status!=='predicted')return unavailable('insufficient_completed_request_groups');
  if(forecast.price_revision!==RATE_PRICE_REVISION||!Array.isArray(forecast.pricing_profiles)
    ||!validComposition(forecast.pricing_profile_cost_shares)
    ||!['p50','p80'].every(k=>number(forecast[k]?.calculated_dollar_equivalent)))return unavailable('priced_cohort_unavailable');
  const windows=reports.filter(r=>r.provider===host);
  if(!windows.length)return unavailable('provider_quota_unavailable');
  const projected=windows.map(r=>{
      const base={provider:host,limit_id:r.limit_id,quota_group:r.quota_group,window_id:r.window_id,resets_at_ms:r.resets_at_ms,
        status:'unavailable',measurement_basis:'estimated',estimated_quota_pp:null,account_coverage:r.account_coverage};
      if(r.status!=='estimated')return {...base,status:'learning',reason_codes:r.reason_codes};
      if(!forecast.pricing_profiles.every(p=>r.pricing_profiles.includes(p)))return {...base,reason_codes:['profile_not_calibrated']};
      const distance=mixDistance(forecast.pricing_profile_cost_shares,r.pricing_profile_cost_shares);
      if(distance===null)return {...base,status:'learning',reason_codes:['profile_composition_unavailable']};
      if(distance>PROFILE_MIX_TV_TOLERANCE)return {...base,status:'learning',reason_codes:['profile_mix_changed']};
      if(!number(forecast.p80.duration_ms)||now+forecast.p80.duration_ms>=r.resets_at_ms)return {...base,reason_codes:['forecast_crosses_quota_reset']};
      const project=key=>({estimated_quota_pp:round(forecast[key].calculated_dollar_equivalent*r.per_api_dollar),
        lower_quota_pp:round(forecast[key].calculated_dollar_equivalent*r.lower_per_api_dollar),upper_quota_pp:round(forecast[key].calculated_dollar_equivalent*r.upper_per_api_dollar)});
      return {...base,status:'predicted',reason_codes:[],p50:project('p50'),p80:project('p80'),bounds_basis:'empirical_cost_quantiles_with_quota_rounding_bounds'};
    });
  return {status:projected.some(r=>r.status==='predicted')?'predicted':projected.some(r=>r.status==='learning')?'learning':'unavailable',
    measurement_basis:'estimated',prediction_unit:'request_group',sample_count:forecast.sample_count,quota_windows:projected};
}
