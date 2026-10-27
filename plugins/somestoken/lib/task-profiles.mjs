import fs from 'node:fs';
import path from 'node:path';
import {hashId,hashOpaqueHostIdentifier,isHashedIdentity,safeModel} from './core.mjs';
import {acquireStoreLock} from './monitor-lock.mjs';
import {readWorkspaceFile,writeWorkspaceFile} from './workspace-store.mjs';
import {FORECAST_FEATURE_KEYS,normalizeForecastFeatures,selectForecastCohort,forecastTaskUsage} from './usage/forecast.mjs';

export const DECLARED_WORK_KEYS=Object.freeze(['workload','context_band','scope_band','verification_band','planned_subagent_policy']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const safe=value=>safeModel(value)??'unknown';
export const forecastTaskKey=(host,id)=>['codex','claude'].includes(host)
  ?hashOpaqueHostIdentifier(id,host==='claude'?'workspace:claude:task':'workspace:task'):null;
function projectKey(host,cwd) {
  if(!['codex','claude'].includes(host)||typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.length>4096)return null;
  try{return host+':'+hashId(fs.realpathSync(cwd));}catch{return null;}
}
function validWork(value) {
  const features={host:'codex',model:'declared',effort:'declared',service_tier:'standard',
    ...Object.fromEntries(DECLARED_WORK_KEYS.map(key=>[key,value?.[key]]))};
  return normalizeForecastFeatures(features)?Object.fromEntries(DECLARED_WORK_KEYS.map(key=>[key,value[key]])):null;
}
function editProfiles(directory,edit) {
  const release=acquireStoreLock(directory,'profiles.lock');
  try {
    let exists=false;
    try{fs.lstatSync(path.join(directory,'task-profiles.json'));exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    const saved=readWorkspaceFile(directory,'task-profiles.json');
    if(exists&&!object(saved))throw new Error('Invalid task profile store');
    const profiles=saved??{},result=edit(profiles);
    if(result.changed)writeWorkspaceFile(directory,'task-profiles.json',profiles);
    return result;
  }finally{release();}
}
export function setProjectForecastProfile(directory,{host,cwd,...features},at=Date.now()) {
  const key=projectKey(host,cwd),work=validWork(features);
  if(!key||!work||!Number.isSafeInteger(at)||at<0)throw new Error('Invalid project forecast profile');
  return editProfiles(directory,profiles=>{
    const defaults=object(profiles.project_defaults)?profiles.project_defaults:{};
    delete defaults[key];defaults[key]={...work,declared_at:at};
    profiles.project_defaults=Object.fromEntries(Object.entries(defaults).slice(-128));
    return {changed:true};
  });
}
function numeric(profile) {
  return normalizeForecastFeatures(profile)&&Number.isSafeInteger(profile.created_at)&&profile.created_at>=0
    &&profile.prediction?.status==='predicted'&&profile.prediction.prediction_unit==='request_group'
    &&Number.isSafeInteger(profile.prediction.p50?.total_tokens)&&profile.prediction.p50.total_tokens>=0
    &&Number.isSafeInteger(profile.prediction.p80?.total_tokens)&&profile.prediction.p80.total_tokens>=profile.prediction.p50.total_tokens
    &&Number.isSafeInteger(profile.baseline_tokens)&&profile.baseline_tokens>=0;
}
function revision(existing,features,samples,taskKey,at,basis) {
  const cohort=selectForecastCohort(samples,features,{at,task_key:taskKey}).samples;
  const baseline=cohort.map(sample=>sample.total_tokens).sort((a,b)=>a-b);
  const current={...features,created_at:at,forecast_profile_basis:basis,
    prediction:forecastTaskUsage(samples,features,{at,task_key:taskKey}),
    baseline_tokens:baseline.length?baseline[Math.ceil(baseline.length/2)-1]:null};
  const prior=existing?.frozen_prediction??(existing?.prediction?{
    ...Object.fromEntries(FORECAST_FEATURE_KEYS.map(key=>[key,existing[key]])),created_at:existing.created_at,
    prediction:existing.prediction,baseline_tokens:existing.baseline_tokens}:null);
  const frozen=numeric(prior)?prior:numeric(current)?current:null;
  const earlier=Array.isArray(existing?.profile_revisions)?existing.profile_revisions.slice(-49):prior?[prior]:[];
  return {...current,...(frozen?{frozen_prediction:frozen}:{}),profile_revisions:[...earlier,current].slice(-50)};
}
export function registerTaskForecastProfile(directory,taskKey,features,{at=Date.now(),automatic=false,cwd=null}={}) {
  if(!isHashedIdentity(taskKey)||!['codex','claude'].includes(features?.host)||!Number.isSafeInteger(at)||at<0
    ||(!automatic&&(!normalizeForecastFeatures(features)||!safeModel(features.model)||!safeModel(features.effort))))throw new Error('Invalid task profile');
  return editProfiles(directory,profiles=>{
    const existing=profiles[taskKey];
    if(existing?.created_at>at)throw new Error('Task profile clock moved backwards');
    // Persist only forecast controls, never caller content or supplied evidence.
    let controls=normalizeForecastFeatures(features);
    let declaredControls=normalizeForecastFeatures(existing?.declared_controls);
    const planInvalidated=Boolean(automatic&&declaredControls&&['model','effort','service_tier'].some(key=>
      features[key]!=null&&safe(features[key])!==declaredControls[key]));
    if(planInvalidated)declaredControls=null;
    if(automatic) {
      const project=profiles.project_defaults?.[projectKey(features.host,cwd)];
      const declared=validWork(existing?.declared_work)??(Number.isSafeInteger(project?.declared_at)&&project.declared_at<=at?validWork(project):null);
      controls={...Object.fromEntries(DECLARED_WORK_KEYS.map(key=>[key,declared?.[key]??'unknown'])),
        ...Object.fromEntries(['host','model','effort','service_tier'].map(key=>[key,safe(features[key]??declaredControls?.[key])]))};
      if(existing&&!planInvalidated&&FORECAST_FEATURE_KEYS.every(key=>existing[key]===controls[key])
        &&(!normalizeForecastFeatures(controls)||numeric(existing)))return {changed:false};
    }
    // Only cohort summaries are retained by the hook; no transcript content.
    let samples=[];
    if(normalizeForecastFeatures(controls)) {
      if(automatic) {
        const health=readWorkspaceFile(directory,'monitor.json'),training=health?.forecast_training;
        if(training?.source_snapshot_at===health?.last_snapshot_at&&Number.isSafeInteger(training?.source_snapshot_at)
          &&training.source_snapshot_at<=at&&Array.isArray(training.samples))samples=training.samples.slice(-1000);
      }else samples=readWorkspaceFile(directory,'workspace.json',{includeRecords:false})?.samples??[];
    }
    const next=revision(existing,controls,samples,taskKey,at,automatic?'prospective_declaration_and_host_metadata':'explicit_task_registration');
    if(automatic&&existing&&!planInvalidated&&FORECAST_FEATURE_KEYS.every(key=>existing[key]===controls[key])
      &&JSON.stringify(existing.prediction)===JSON.stringify(next.prediction))return {changed:false};
    if(!automatic){
      next.declared_work=Object.fromEntries(DECLARED_WORK_KEYS.map(key=>[key,features[key]]));
      next.declared_controls=normalizeForecastFeatures(features);
    }else {
      if(validWork(existing?.declared_work))next.declared_work=existing.declared_work;
      if(declaredControls)next.declared_controls=declaredControls;
    }
    delete profiles[taskKey];profiles[taskKey]=next;
    const keys=Object.keys(profiles).filter(isHashedIdentity);
    for(const key of keys.slice(0,-1000))delete profiles[key];
    return {changed:true};
  });
}
/** Missing host fields stay unknown; prompt text and previous responses cannot
 * establish current model/effort. Failure never blocks the host workflow. */
export function captureTaskForecastProfile(directory,input,host,event,at=Date.now()) {
  if(!directory||!['SessionStart','UserPromptSubmit'].includes(event)||input?.agent_id)return {status:'ignored'};
  const taskKey=forecastTaskKey(host,input?.session_id);if(!taskKey)return {status:'ignored'};
  try {
    const result=registerTaskForecastProfile(directory,taskKey,{host,model:input.model??input.resolved_model,
      effort:input.reasoning_effort??input.effort,service_tier:input.service_tier??input.effective_service_tier},
    {at,automatic:true,cwd:input.cwd});
    return {status:result.changed?'registered':'unchanged'};
  }catch{return {status:'unavailable'};}
}
