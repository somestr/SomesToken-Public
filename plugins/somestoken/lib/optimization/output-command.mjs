import fs from 'node:fs';
import {humanLabel} from '../core.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {projectToolResult} from './tool-output.mjs';
import {TEST_REPORT_FORMATS,MAX_TEST_REPORT_BYTES} from './test-report-formats.mjs';
import {outputIdentity,recordOutputPreparation,recordOutputRead,outputCompactionSummary} from './output-accounting.mjs';
import {mutateOptimizationState} from '../runtime.mjs';
import {readSomesTokenState} from '../report-adapter.mjs';

const COMMON=['--host','--task-id','--run-id','--model','--effort','--source-type'];
const error=code=>{throw Error(code);};
function options(args) {
 const action=args[0],allowed=action==='report'?['--json']:action==='summarize'?[...COMMON,'--input','--format','--exit-code','--max-bytes']:action==='read'?[...COMMON,'--input','--id','--offset','--bytes']:[];
 if(!['report','summarize','read'].includes(action))error('invalid_output_action');
 const result={};for(let i=1;i<args.length;i++){
  const key=args[i];if(!allowed.includes(key)||Object.hasOwn(result,key))error('invalid_output_options');
  if(key==='--json'){result[key]=true;continue;}
  if(args[i+1]===undefined||args[i+1].startsWith('--'))error('invalid_output_options');result[key]=args[++i];
 }
 return {action,...result};
}
function number(value,min,max,fallback) {
 if(value===undefined)return fallback;
 if(!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)error('invalid_output_options');
 return Number(value);
}
function readReport(file) {
 if(typeof file!=='string'||!file||file.includes('\0'))error('invalid_report_file');
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const before=fs.fstatSync(fd);
  if(!before.isFile()||before.size>MAX_TEST_REPORT_BYTES)error('report_too_large_or_not_regular');
  const buffer=Buffer.alloc(before.size+1);let size=0,n;
  while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null)))size+=n;
  const after=fs.fstatSync(fd);
  if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)error('source_changed');
  return buffer.subarray(0,size);
 }catch(e){if(['report_too_large_or_not_regular','source_changed'].includes(e.message))throw e;error('invalid_report_file');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** Explicit local report preparation; never runs a shell command or intercepts host tools. */
export async function runOutputCommand(args,env=process.env) {
 try{
  const o=options(args);
  if(o.action==='report'){
   const summary=outputCompactionSummary(readSomesTokenState(env).state?.optimization?.output_compaction);
   process.stdout.write(`${JSON.stringify(summary)}\n`);return;
  }
  const host=o['--host']??env.SOMESTOKEN_RUNTIME;
  if(!['codex','claude'].includes(host)||(env.SOMESTOKEN_RUNTIME&&env.SOMESTOKEN_RUNTIME!==host))error('invalid_output_host');
  const context=outputIdentity({host,task_id:o['--task-id']??(host==='codex'?env.CODEX_THREAD_ID:undefined),run_id:o['--run-id'],
   model:o['--model'],effort:o['--effort'],source_type:o['--source-type']});
  const id=randomBytes(10).toString('hex'),created_at=Date.now();
  const limit=number(o['--bytes'],1,65536,65536),offset=number(o['--offset'],0,MAX_TEST_REPORT_BYTES,0);
  const maxBytes=number(o['--max-bytes'],256,65536,16384);
  const exitCode=o.action==='summarize'?number(o['--exit-code'],0,255,null):0;
  if(o.action==='summarize'&&(!TEST_REPORT_FORMATS.includes(o['--format'])||exitCode===null))error('invalid_output_options');
  if(o.action==='read'&&!/^[a-f0-9]{20}$/.test(o['--id']??''))error('invalid_output_options');
  const raw=readReport(o['--input']),input_sha256=createHash('sha256').update(raw).digest('hex');
  if(o.action==='read'){
   if(offset>raw.length)error('invalid_output_range');
   const content=raw.subarray(offset,Math.min(raw.length,offset+limit));
   const recorded=await mutateOptimizationState({...env,SOMESTOKEN_RUNTIME:host},state=>recordOutputRead(state.output_compaction,
    {...context,id,created_at,receipt_id:o['--id'],input_sha256,bytes:content.length}));
   if(!recorded?.ok)error(recorded?.error??'accounting_unavailable');process.stdout.write(content);return;
  }
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{ /* Keep undecodable reports intact, with numeric preparation accounting. */ }
  const result=text===undefined?{mode:'passthrough',summary:{stdout:raw}}:
   projectToolResult({format:o['--format'],stdout:text,stderr:'',exitCode,maxBytes,suffix:`SomesToken output ${id}\n`});
  const record={...context,id,created_at,format:o['--format'],input_sha256,input_bytes:raw.length,output_bytes:Buffer.byteLength(result.summary.stdout),mode:result.mode};
  const recorded=await mutateOptimizationState({...env,SOMESTOKEN_RUNTIME:host},state=>recordOutputPreparation(state.output_compaction,record));
  if(!recorded?.ok){process.stdout.write(raw);process.stderr.write('SomesToken output · accounting unavailable; original report retained · Next: check diagnostics before preparing another report.\n');}
  else process.stdout.write(result.summary.stdout);
  process.exitCode=exitCode;
 }catch(e){
  const known=new Set(['invalid_output_action','invalid_output_options','invalid_report_file','report_too_large_or_not_regular','source_changed','invalid_output_host','invalid_output_range','output_record_unavailable','scope_mismatch','accounting_unavailable','plugin_data_unavailable','state_unavailable']);
  process.stderr.write(`SomesToken output · ${humanLabel(known.has(e.message)?e.message:'output_unavailable')} · Next: use optimization.mjs --help and check the report file.\n`);process.exitCode=2;
 }
}
