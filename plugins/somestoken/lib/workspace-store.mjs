import { unlinkOwnedFile } from './host-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isValidUsage,USAGE_KEYS,safeModel,isHashedIdentity} from './core.mjs';


const LABEL=/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const validLabel=value=>typeof value==='string'&&LABEL.test(value)&&Boolean(safeModel(value.replaceAll('+','.')));
// quota.json holds compacted quota history, a subset of workspace.json, so
// both share one bound; a smaller sidecar cap fails at steady state (~1 MiB).
export const STORE_BOUND=64*1024*1024;
// plugin-data.json: the data folder each host gave SomesToken's hook (see handoff/hook.mjs).
const STORE_NAMES=new Set(['workspace.json','task-profiles.json','monitor.json','quota.json','plugin-data.json','codex-resume.json','codex-headers.json']);
// Version 2 also leaves out usage fields that follow from the others: `consistent`
// when true, `total_tokens` when it equals input plus output, and a zero
// `cache_write_input_tokens`. Version 1 files always hold complete usage, so one
// expansion reads both; files are written as version 2.
export const RECORD_DEFAULTS_VERSION=2;
const READABLE_DEFAULTS_VERSIONS=new Set([1,2]);
const DERIVED_USAGE=['total_tokens','cache_write_input_tokens','consistent'];

function validRecord(record) {
  return record && ['record_key','task_key','source_key','turn_key'].every(key=>isHashedIdentity(record[key]??''))
    && ['main','subagent'].includes(record.role) && validLabel(record.model??'') && validLabel(record.effort??'')
    && Number.isSafeInteger(record.observed_at) && record.observed_at>0
    && isValidUsage(record.usage,{reasoningObserved:record.host!=='claude'});
}

export function canonicalRecord(record) {
  return validRecord(record)
    && ['codex','claude'].includes(record.host)
    && ['observed','historical_unverified'].includes(record.validation_status)
    && record.reasoning_usage_status===(record.host==='claude'?'unmeasured':'observed')
    && (isHashedIdentity(record.root_key??'')||record.record_basis==='legacy_counter_event'&&record.root_key===null)
    && (record.parent_source===null||isHashedIdentity(record.parent_source??''))
    && validLabel(record.service_tier??'') && validLabel(record.requested_service_tier??'')
    && (record.capture_origin===null||['hook','registered_refresh'].includes(record.capture_origin))
    && (record.captured_at===null||Number.isSafeInteger(record.captured_at))
    && (record.collector_version===null||validLabel(record.collector_version??''))
    && typeof record.completed==='boolean'
    && (record.completed_at===null||Number.isSafeInteger(record.completed_at))
    && (record.duration_ms===null||Number.isSafeInteger(record.duration_ms)&&record.duration_ms>=0)
    && ['structured_response','legacy_counter_event'].includes(record.record_basis)
    && (record.quality==='partial'||record.quality==='exact'&&record.record_basis!=='legacy_counter_event');
}

/** A reader-owned row can be reused by the collector without allocating a
 * normalization copy. Extra/future fields still take the sanitizing path. */
export function reusableWorkspaceRecord(record) {
  return canonicalRecord(record)&&Object.keys(record).length===24
    &&Object.keys(record.usage).length===USAGE_KEYS.length+1
    &&[...USAGE_KEYS,'consistent'].every(key=>Object.hasOwn(record.usage,key));
}

function defaultRecordField(record,key,value) {
  switch(key) {
    case 'host':return value==='codex';
    case 'validation_status':return value==='observed';
    case 'reasoning_usage_status':return value===(record.host==='claude'?'unmeasured':'observed');
    case 'root_key':return value===(record.record_basis==='legacy_counter_event'?null:record.turn_key);
    case 'parent_source':case 'capture_origin':case 'captured_at':case 'collector_version':case 'completed_at':case 'duration_ms':return value===null;
    case 'service_tier':case 'requested_service_tier':return value==='unknown';
    case 'completed':return value===false;
    case 'record_basis':return value==='structured_response';
    case 'quality':return value==='partial';
    default:return false;
  }
}

function defaultUsageField(usage,key) {
  switch(key) {
    case 'consistent':return usage.consistent===true;
    case 'total_tokens':return Number.isSafeInteger(usage.total_tokens)&&usage.total_tokens===usage.input_tokens+usage.output_tokens;
    case 'cache_write_input_tokens':return usage.cache_write_input_tokens===0;
    default:return false;
  }
}

export function compactRecord(record) {
  const compact=Object.create(null);
  for(const key of Object.keys(record))if(!defaultRecordField(record,key,record[key]))compact[key]=record[key];
  const usage=record.usage;
  if(usage&&typeof usage==='object'&&!Array.isArray(usage)&&Number.isSafeInteger(usage.input_tokens)&&Number.isSafeInteger(usage.output_tokens)){
    const kept=Object.create(null);
    for(const key of Object.keys(usage))if(!defaultUsageField(usage,key))kept[key]=usage[key];
    compact.usage=kept;
  }
  return compact;
}

const RECORD_DEFAULTS={host:'codex',validation_status:'observed',reasoning_usage_status:'observed',
  root_key:null,parent_source:null,service_tier:'unknown',requested_service_tier:'unknown',
  capture_origin:null,captured_at:null,collector_version:null,completed:false,completed_at:null,duration_ms:null,record_basis:'structured_response',quality:'partial'};
const RECORD_DEFAULT_KEYS=Object.keys(RECORD_DEFAULTS);

export function expandRecord(record) {
  // These freshly parsed rows belong to the reader; no caller can observe an
  // intermediate value. Preserve explicit fields (including future metadata).
  for(const key of RECORD_DEFAULT_KEYS)if(!Object.hasOwn(record,key)){
    record[key]=key==='root_key'?(record.record_basis==='legacy_counter_event'?null:record.turn_key)
      :key==='reasoning_usage_status'&&record.host==='claude'?'unmeasured':RECORD_DEFAULTS[key];
  }
  // Usage left out by version 2 is restored in the usual key order.
  const usage=record.usage;
  if(usage&&typeof usage==='object'&&!Array.isArray(usage)&&DERIVED_USAGE.some(key=>!Object.hasOwn(usage,key))){
    const derived={cache_write_input_tokens:0,consistent:true};
    if(Number.isSafeInteger(usage.input_tokens)&&Number.isSafeInteger(usage.output_tokens))derived.total_tokens=usage.input_tokens+usage.output_tokens;
    const hasOwnProto=Object.hasOwn(usage,'__proto__'),restored=hasOwnProto?Object.create(null):{};
    for(const key of new Set([...USAGE_KEYS,'consistent',...Object.keys(usage)])){
      const value=Object.hasOwn(usage,key)?usage[key]:derived[key];
      if(value!==undefined)restored[key]=value;
    }
    if(hasOwnProto)Object.setPrototypeOf(restored,Object.prototype);
    record.usage=restored;
  }
  return record;
}

function expandWorkspace(value,name,projection=null) {
  if(name!=='workspace.json'||!Object.hasOwn(value??{},'record_defaults_version'))return value;
  if(value?.schema_version!==1||!READABLE_DEFAULTS_VERSIONS.has(value.record_defaults_version)||!Array.isArray(value.records)
    ||!(projection?.recordsCount??value.records.length)||projection?.invalidCompactRows)throw new Error('invalid-record-defaults');
  delete value.record_defaults_version;
  for(let index=0;index<value.records.length;index++){
    const record=expandRecord(value.records[index]);
    if(!canonicalRecord(record))throw new Error('invalid-record-defaults');
    value.records[index]=record;
  }
  return value;
}

function* workspaceChunks(value,name,marks={}) {
  if(name!=='workspace.json'||!value||typeof value!=='object'||Array.isArray(value)){
    yield JSON.stringify(value);return;
  }
  const compact=value.schema_version===1&&Array.isArray(value.records)&&value.records.length>0&&value.records.every(canonicalRecord);
  yield '{';let first=true;
  for(const key of Object.keys(value)){
    const field=value[key];
    if(field===undefined||typeof field==='function'||typeof field==='symbol')continue;
    if(!first)yield ',';first=false;yield JSON.stringify(key)+':';
    if(Array.isArray(field)){
      marks.records=key==='records';
      yield '[';
      for(let i=0;i<field.length;i++){
        if(i)yield ',';
        yield JSON.stringify(compact&&key==='records'?compactRecord(field[i]):field[i])??'null';
      }
      yield ']';marks.records=false;
    }else yield JSON.stringify(field);
  }
  if(compact)yield ',"record_defaults_version":'+RECORD_DEFAULTS_VERSION;
  yield '}';
}

// Overflow recovery needs this snapshot's metadata size, not its predecessor's.
export function workspaceStoreBound(value,compact=false) {
  let bytes=-2; // Exclude the empty records array, as record_bytes does.
  for(const text of workspaceChunks({...value,records:[]},'workspace.json'))bytes+=Buffer.byteLength(text);
  if(compact)bytes+=Buffer.byteLength(',"record_defaults_version":'+RECORD_DEFAULTS_VERSION);
  return Object.assign(new Error('store-bound'),{non_record_bytes:bytes});
}

// Decode top-level arrays one entry at a time. JSON.parse still validates each
// complete value; a large snapshot never needs a second full UTF-8/string copy.
function readWorkspaceJSON(fd,options={}) {
  const buffer=Buffer.allocUnsafe(64*1024);
  const projection={recordsCount:0,invalidCompactRows:false};
  const keep=(key,item)=>{
    if(key==='records')projection.recordsCount++;
    // Streaming readers take each response as it is decoded; nothing is kept.
    if(key==='records'&&options.onRecord){options.onRecord(item);return false;}
    if(!['records','tasks','daily'].includes(key))return true;
    const selected=!(key==='records'&&options.includeRecords===false)
      &&(!options.taskKey||item?.task_key===options.taskKey)&&(!options.host||(item?.host??'codex')===options.host);
    if(!selected&&key==='records'&&(!item||typeof item!=='object'||Array.isArray(item)||!canonicalRecord(expandRecord(item))))projection.invalidCompactRows=true;
    return selected;
  };
  const metadataStrings=new Map(),metadataKeys=['task_key','source_key','turn_key','root_key','parent_source','model','effort','service_tier','requested_service_tier','collector_version'];
  const entry=(key,item)=>{
    if(key==='records'&&item&&typeof item==='object'&&!Array.isArray(item))for(const field of metadataKeys){
      const text=item[field];if(typeof text!=='string'||text.length>80)continue;
      if(metadataStrings.has(text))item[field]=metadataStrings.get(text);
      else if(metadataStrings.size<20000)metadataStrings.set(text,text);
    }
    return item;
  };
  // Delimiters, quotes and brackets are ASCII bytes, which never occur inside a
  // UTF-8 multi-byte sequence, so values are found on the raw bytes and only
  // the kept ones are decoded. Byte codes: , 44  : 58  [ 91  ] 93  { 123  } 125.
  let length=0,position=0,bytes=0,ended=false;
  const peek=()=>{
    while(position>=length&&!ended){
      length=fs.readSync(fd,buffer,0,buffer.length,null);bytes+=length;position=0;ended=!length;
      if(bytes>STORE_BOUND)throw Error('store-bound');
    }
    return position<length?buffer[position]:-1;
  };
  const whitespace=()=>{for(let c=peek();c===32||c===9||c===13||c===10;c=peek())position++;};
  const expect=code=>{whitespace();if(peek()!==code)throw Error('invalid-json');position++;};
  // Advance to the next top-level `first`/`second` byte (or the end); with
  // `collect`, return the text passed over.
  const advance=(first,second,collect)=>{
    let depth=0,quoted=false,escaped=false,parts=null;
    while(peek()>=0){
      const start=position,n=length;let p=position;
      for(;p<n;p++){
        const c=buffer[p];
        if(quoted){if(escaped)escaped=false;else if(c===92)escaped=true;else if(c===34)quoted=false;}
        else if(depth===0&&(c===first||c===second))break;
        else if(c===34)quoted=true;else if(c===123||c===91)depth++;else if(c===125||c===93)depth--;
      }
      position=p;
      if(p<n){
        if(!collect)return;
        return (parts?Buffer.concat([...parts,buffer.subarray(start,p)]):buffer.subarray(start,p)).toString('utf8');
      }
      if(collect)(parts??=[]).push(Buffer.from(buffer.subarray(start,p)));
    }
    if(collect)return parts?Buffer.concat(parts).toString('utf8'):'';
  };
  const value=(first,second,raw=false)=>{const text=advance(first,second,true);return raw?text:JSON.parse(text);};
  whitespace();
  if(peek()!==123)return {value:value(-1,-1),projection};
  position++;const result={};whitespace();
  if(peek()!==125)while(true){
    const key=value(58,58);if(typeof key!=='string')throw Error('invalid-json');expect(58);whitespace();
    let field;
    if(options.recordsOnly&&key!=='records'&&key!=='record_defaults_version'||options.skipKeys?.has(key)){advance(44,125,false);whitespace();if(peek()!==44)break;position++;whitespace();if(peek()===125)throw Error('invalid-json');continue;}
    if(peek()===91){
      position++;field=[];whitespace();
      if(key==='records'){projection.recordsCount=0;projection.invalidCompactRows=false;}
      if(peek()!==93)while(true){
        const item=value(44,93,key==='records'&&options.rawRecords===true);if(keep(key,item))field.push(entry(key,options.mapItem?options.mapItem(key,item):item));whitespace();
        if(peek()!==44)break;
        position++;whitespace();if(peek()===93)throw Error('invalid-json');
      }
      expect(93);
    }else field=value(44,125);
    Object.defineProperty(result,key,{value:field,writable:true,enumerable:true,configurable:true});
    whitespace();if(peek()!==44)break;
    position++;whitespace();if(peek()===125)throw Error('invalid-json');
  }
  expect(125);whitespace();if(peek()>=0)throw Error('invalid-json');return {value:result,projection};
}

/**
 * Streams the snapshot's responses to `onRecord` in file order (compact rows
 * as stored) and returns the other fields. Null when the file is unusable or
 * `onRecord` throws. `compact` is false for a snapshot without row defaults.
 */
export function streamWorkspaceRecords(directory,onRecord,{recordsOnly=false,rawRecords=false,skipKeys,mapItem}={}) {
  let fd;
  try {
    if(!directory||fs.lstatSync(directory).isSymbolicLink())return null;
    fd=fs.openSync(path.join(directory,'workspace.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>STORE_BOUND)return null;
    const {value,projection}=readWorkspaceJSON(fd,{onRecord,recordsOnly,rawRecords,skipKeys,mapItem});
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const compact=value.record_defaults_version===RECORD_DEFAULTS_VERSION;
    delete value.record_defaults_version;delete value.records;
    return {meta:value,count:projection.recordsCount,compact};
  }catch{return null;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** Metadata identity shared by the scheduler and report reader; no usage read. */
export function workspaceSnapshotSignature(directory) {
 try{
  const file=path.join(directory,'workspace.json'),s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink())return null;
  return crypto.createHash('sha256').update(JSON.stringify([file,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode])).digest('hex');
 }catch{return null;}
}

export function readWorkspaceFile(directory,name='workspace.json',options={}) {
  if(!directory||!STORE_NAMES.has(name))return null;
  if((options.taskKey!==undefined&&!isHashedIdentity(options.taskKey))||(options.host!==undefined&&!['codex','claude'].includes(options.host)))return null;
  let fd;
  try {
    if(fs.lstatSync(directory).isSymbolicLink())return null;
    fd=fs.openSync(path.join(directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>STORE_BOUND)return null;
    if(name!=='workspace.json')return readWorkspaceJSON(fd).value;
    const parsed=readWorkspaceJSON(fd,options);
    return expandWorkspace(parsed.value,name,parsed.projection);
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function writeWorkspaceFile(directory,name,value) {
  if(!directory||!STORE_NAMES.has(name))throw new Error('invalid-store');
  if(name==='workspace.json'&&Object.hasOwn(value??{},'record_defaults_version'))throw new Error('reserved-record-defaults-marker');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.lstatSync(directory).isSymbolicLink())throw new Error('unsafe-store');
  const target=path.join(directory,name),temp=target+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  let fd,owned,bytes=0,used=0,recordBytes=0;
  const buffer=Buffer.allocUnsafe(64*1024),marks={records:false};
  const flush=()=>{let offset=0;while(offset<used){const written=fs.writeSync(fd,buffer,offset,used-offset);if(!written)throw new Error('short-write');offset+=written;}used=0;};
  try{
    fd=fs.openSync(temp,'wx',0o600);owned=fs.fstatSync(fd);
    for(const text of workspaceChunks(value,name,marks)){
      const part=Buffer.from(text);bytes+=part.length;if(marks.records)recordBytes+=part.length;
      if(bytes>STORE_BOUND)throw name==='workspace.json'?workspaceStoreBound(value,value?.schema_version===1&&Array.isArray(value.records)&&value.records.length>0&&value.records.every(canonicalRecord)):new Error('store-bound');
      for(let start=0;start<part.length;){
        const count=Math.min(buffer.length-used,part.length-start);
        part.copy(buffer,used,start,start+count);used+=count;start+=count;
        if(used===buffer.length)flush();
      }
    }
    if(used)flush();fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,target);return {bytes_written:bytes,...(name==='workspace.json'?{record_bytes:recordBytes}:{})};
  }finally{try{if(fd!==undefined)fs.closeSync(fd);}finally{unlinkOwnedFile(temp,owned);}}
}

/** Maintenance owns only service output and abandoned atomic-write files.
 * Source transcripts and numeric history are never cleanup candidates. */
export function maintainWorkspaceStorage(directory,{now=Date.now()}={}) {
  const result={reclaimed_bytes:0,removed_temporary_files:0,errors:[]};
  try{
    for(let p=path.resolve(directory);;p=path.dirname(p)){
      const stat=fs.lstatSync(p);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('unsafe_store');
      if(path.dirname(p)===p)break;
    }
    for(const name of ['monitor.stdout.log','monitor.stderr.log']){
      let fd;
      try{
        fd=fs.openSync(path.join(directory,name),fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('unsafe_service_log');
        if(stat.size<=256*1024)continue;
        const tail=Buffer.alloc(64*1024),count=fs.readSync(fd,tail,0,tail.length,stat.size-tail.length);
        const start=tail.subarray(0,count).indexOf(10)+1,retained=tail.subarray(start,count);
        // Preserve the inode held by launchd; replacing its pathname would
        // leave the original open file growing invisibly.
        fs.ftruncateSync(fd,0);let offset=0;
        while(offset<retained.length){const n=fs.writeSync(fd,retained,offset,retained.length-offset,offset);if(!n)throw Error('short_write');offset+=n;}
        result.reclaimed_bytes+=stat.size-retained.length;
      }catch(error){if(error.code!=='ENOENT')result.errors.push(error.code==='ELOOP'||error.message==='unsafe_service_log'?'unsafe_service_log':'service_log_maintenance_failed');}
      finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    for(const name of fs.readdirSync(directory))if(/^(?:workspace|task-profiles|monitor|quota|codex-resume|codex-headers)\.json\.[a-f0-9]{16}\.tmp$/.test(name)){
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&now-stat.mtimeMs>86400000){fs.unlinkSync(file);result.reclaimed_bytes+=stat.size;result.removed_temporary_files++;}
    }
  }catch{result.errors.push('storage_maintenance_failed');}
  result.errors=[...new Set(result.errors)];return result;
}
