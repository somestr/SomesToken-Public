import {safeModel,hashOpaqueHostIdentifier,isHashedIdentity} from '../core.mjs';
import {TEST_REPORT_FORMATS} from './test-report-formats.mjs';

const LIMIT=128,HASH=/^[a-f0-9]{64}$/;
const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=Math.floor(Number.MAX_SAFE_INTEGER/512);
const EFFORTS=['none','minimal','low','medium','high','xhigh','max','ultra','unknown'];
function identity(input) {
 if(!['codex','claude'].includes(input?.host))return null;
 return {host:input.host,task_key:isHashedIdentity(input.task_key??'')?input.task_key:null,
  run_key:isHashedIdentity(input.run_key??'')?input.run_key:null,model:safeModel(input.model)??'unknown',
  effort:EFFORTS.includes(input.effort)?input.effort:'unknown',source_type:['main','subagent'].includes(input.source_type)?input.source_type:'unknown'};
}
export function outputIdentity(input) {
 return identity({...input,task_key:hashOpaqueHostIdentifier(input.task_id,input.host),run_key:hashOpaqueHostIdentifier(input.run_id,input.host)});
}
function normalizeRow(row,read=false) {
 const who=identity(row);if(!who||!isHashedIdentity(row?.id??'')||!count(row.created_at))return null;
 if(read)return isHashedIdentity(row.receipt_id??'')&&count(row.bytes)?{...who,id:row.id,receipt_id:row.receipt_id,created_at:row.created_at,bytes:row.bytes}:null;
 if(!TEST_REPORT_FORMATS.includes(row.format)||typeof row.input_sha256!=='string'||!HASH.test(row.input_sha256)||!count(row.input_bytes)||!count(row.output_bytes)
  ||row.output_bytes>row.input_bytes||!['projected','passthrough'].includes(row.mode))return null;
 return {...who,id:row.id,created_at:row.created_at,format:row.format,input_sha256:row.input_sha256,
  input_bytes:row.input_bytes,output_bytes:row.output_bytes,mode:row.mode};
}
export function normalizeOutputAccounting(value) {
 const out={records:[],reads:[],dropped_records:count(value?.dropped_records)?value.dropped_records:0};
 for(const [key,read] of [['records',false],['reads',true]]){
  const source=Array.isArray(value?.[key])?value[key]:[],seen=new Set();
  out.dropped_records+=Math.max(0,source.length-LIMIT);
  for(const item of source.slice(-LIMIT)){
   const row=normalizeRow(item,read);
   if(row&&!seen.has(row.id)){seen.add(row.id);out[key].push(row);}else out.dropped_records++;
  }
 }
 out.dropped_records=Math.min(out.dropped_records,Math.floor(Number.MAX_SAFE_INTEGER/512));
 return out;
}
export function recordOutputPreparation(state,input) {
 const row=normalizeRow(input);if(!row)return {ok:false,error:'invalid_output_record'};
 const current=normalizeOutputAccounting(state);
 if(current.records.some(r=>r.id===row.id))return {ok:false,error:'duplicate_output_id'};
 current.records.push(row);Object.assign(state,normalizeOutputAccounting(current));return {ok:true,id:row.id};
}
export function recordOutputRead(state,input) {
 const row=normalizeRow(input,true),current=normalizeOutputAccounting(state);
 if(!row)return {ok:false,error:'invalid_output_read'};
 const original=current.records.find(r=>r.id===row.receipt_id);
 if(!original)return {ok:false,error:'output_record_unavailable'};
 if(original.input_sha256!==input.input_sha256)return {ok:false,error:'source_changed'};
 if(['host','task_key','run_key'].some(k=>original[k]!==row[k]))return {ok:false,error:'scope_mismatch'};
 if(current.reads.some(r=>r.id===row.id))return {ok:false,error:'duplicate_output_id'};
 current.reads.push(row);Object.assign(state,normalizeOutputAccounting(current));return {ok:true};
}

const COUNTERS=['prepared_outputs','projected_outputs','input_bytes','output_bytes','retrieval_count','retrieval_bytes'];
export function outputCompactionSummary(value) {
 const state=normalizeOutputAccounting(value),groups=new Map();
 const group=row=>{
  const who=identity(row),key=JSON.stringify(who);
  if(!groups.has(key))groups.set(key,{...who,...Object.fromEntries(COUNTERS.map(k=>[k,0]))});
  return groups.get(key);
 };
 for(const row of state.records){const g=group(row);g.prepared_outputs++;g.projected_outputs+=Number(row.mode==='projected');g.input_bytes+=row.input_bytes;g.output_bytes+=row.output_bytes;}
 for(const row of state.reads){const g=group(row);g.retrieval_count++;g.retrieval_bytes+=row.bytes;}
 return {schema_version:1,measurement_basis:'prepared_payload_bytes',coverage:'instrumented_calls_only',identity_basis:'caller_declared',
  token_savings:'unmeasured',account_quota_savings:'unmeasured',dropped_records:state.dropped_records,
  groups:[...groups.values()].map(g=>({...g,net_bytes_avoided:g.input_bytes-g.output_bytes-g.retrieval_bytes}))};
}
export function sanitizeOutputCompactionSummary(value) {
 if(value?.schema_version!==1||!Array.isArray(value.groups)||value.groups.length>LIMIT*2||!count(value.dropped_records))return null;
 const groups=[];
 for(const row of value.groups){
  const who=identity(row);
  if(!who||!COUNTERS.every(k=>count(row[k]))||row.projected_outputs>row.prepared_outputs||row.output_bytes>row.input_bytes)return null;
  groups.push({...who,...Object.fromEntries(COUNTERS.map(k=>[k,row[k]])),net_bytes_avoided:row.input_bytes-row.output_bytes-row.retrieval_bytes});
 }
 const compact=value.grouping_basis==='host_model_effort';
 return {...outputCompactionSummary(null),dropped_records:value.dropped_records,groups,
  ...(compact?{grouping_basis:'host_model_effort',rolled_up_groups:count(value.rolled_up_groups)?value.rolled_up_groups:0}:{})};
}

// Compact snapshots retain every byte counter, but not task/run identifiers.
// At most 64 model groups plus one overflow group per host fit the 64 KiB bridge.
export function compactOutputCompactionSummary(value) {
 const summary=sanitizeOutputCompactionSummary(value);if(!summary)return null;
 const groups=new Map();let rolled=summary.rolled_up_groups??0;
 for(const row of summary.groups){
  let who={...identity(row),task_key:null,run_key:null},key=JSON.stringify(who);
  if(!groups.has(key)&&groups.size>=64){
   who={host:row.host,task_key:null,run_key:null,model:'unknown',effort:'unknown',source_type:'unknown'};
   const overflowKey=JSON.stringify(who);if(key!==overflowKey)rolled++;key=overflowKey;
  }
  if(!groups.has(key))groups.set(key,{...who,...Object.fromEntries(COUNTERS.map(k=>[k,0]))});
  const target=groups.get(key);for(const counter of COUNTERS)target[counter]+=row[counter];
 }
 return sanitizeOutputCompactionSummary({...summary,grouping_basis:'host_model_effort',rolled_up_groups:rolled,groups:[...groups.values()]});
}
