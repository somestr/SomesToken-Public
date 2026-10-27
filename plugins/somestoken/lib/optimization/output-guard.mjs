import fs from 'node:fs';
import path from 'node:path';
import {humanLabel} from '../core.mjs';
import {isHostOwnedAbsolutePath} from '../host-paths.mjs';
import {STATE_DIR_NAME,hookEnvironment,safeStateDirectory,withLock} from '../runtime/hot-path.mjs';

// Opt-in output guards, off by default, each with its own switch, file and
// counters. After a large result from a test runner (`tests`) or a shell file
// read or search (`reads`) it adds one fixed note; it never blocks, rewrites or
// stores the command. The command and output are read in memory only; the
// files hold the switch and numeric counters.
// ponytail: one 8 KiB threshold (the carry probe's) and a few commands per kind;
// `npm test` hides its runner, and Claude's Read and Grep tools are not shell
// commands, so neither is matched. The note repeats for every large result.
const MIN_OUTPUT_BYTES=8192,MAX_COMMAND_CHARS=2000,MAX_FILE_BYTES=4096;
// Reads are not anchored after a pipe: `… | head` filters another command's output.
const AT='(?:^|[;&|\\n]\\s*)',READ_AT='(?:^|[;&\\n]\\s*)';
// Classification order: test runners, then searches (a pipe into grep yields grep's output), then reads.
const KINDS={
 tests:{file:'output-guard.json',counters:['compact','nudged','runs'],rules:{
  node_test:{label:'Node test',pattern:new RegExp(`${AT}node\\s+(?:\\S+\\s+)*?--test(?=\\s|$)`)},
  pytest:{label:'pytest',pattern:new RegExp(`${AT}(?:(?:uv|poetry)\\s+run\\s+)?(?:python3?\\s+-m\\s+)?pytest(?=\\s|$)`)},
  go_test:{label:'go test',pattern:new RegExp(`${AT}go\\s+test(?=\\s|$)`)},
 }},
 reads:{file:'read-guard.json',counters:['nudged','runs'],rules:{
  search:{pattern:new RegExp(`${AT}(?:git\\s+grep|rg|grep|find|fd)(?=\\s|$)`)},
  file_read:{pattern:new RegExp(`${READ_AT}(?:cat|nl|head|tail|sed\\s+-n)(?=\\s|$)`)},
 }},
};
const COMPACT=/node-test-compact-reporter|optimization\.mjs"?\s+output\s+summarize/;
// Paths are quoted inside the note, so they may not carry shell syntax.
const safe=value=>isHostOwnedAbsolutePath(value)&&/^\/[A-Za-z0-9 ._/+@-]+$/.test(value);
const fresh=kind=>Object.fromEntries(Object.keys(KINDS[kind].rules).map(id=>[id,Object.fromEntries(KINDS[kind].counters.map(c=>[c,0]))]));
const bytes=value=>typeof value==='string'?Buffer.byteLength(value):0;
const classify=command=>{for(const [kind,{rules}] of Object.entries(KINDS))for(const [rule,{pattern}] of Object.entries(rules))if(pattern.test(command))return {kind,rule};return null;};
const READ_NOTES={
 file_read:"that file read was large. When you need only part of a file, find the lines with rg -n 'PATTERN' FILE first, then read that range with sed -n 'START,ENDp' FILE.",
 search:"that search output was large. When fewer matches will do, list files with rg -l 'PATTERN' PATH, cap matches per file with rg -m 3, or narrow the path or glob (rg -g '*.EXT').",
};

/** The exact note for a rule; the plugin root and data root are its only variables. */
export function guardNote(rule,host,root,data) {
 if(Object.hasOwn(READ_NOTES,rule))return `SomesToken read guard (opt-in): ${READ_NOTES[rule]}`;
 const tmp='${TMPDIR:-/tmp}/somestoken-';
 const summary=(format,file)=>`PLUGIN_DATA="${data}" node "${root}/bin/optimization.mjs" output summarize --host ${host} --format ${format} --input "${tmp}${file}" --exit-code $s`;
 const run={
  node_test:`node --test --test-reporter="${root}/lib/optimization/node-test-compact-reporter.mjs" <same test files>`,
  pytest:`pytest -q --junitxml="${tmp}pytest.xml" <same args> > "${tmp}pytest.log"; s=$?; ${summary('junit-xml','pytest.xml')}`,
  go_test:`go test -json <same args> > "${tmp}go.json"; s=$?; ${summary('go-test-json','go.json')}`,
 }[rule];
 return `SomesToken output guard (opt-in): that ${KINDS.tests.rules[rule].label} output was large. Next time, keep failures and counts with: ${run}`;
}

function validGuard(value,kind) {
 const keys=o=>o&&typeof o==='object'&&!Array.isArray(o)?Object.keys(o).sort().join():null;
 const count=n=>Number.isSafeInteger(n)&&n>=0,{rules,counters}=KINDS[kind];
 if(keys(value)!=='enabled,rules,schema'||value.schema!==1||typeof value.enabled!=='boolean'||keys(value.rules)!==Object.keys(rules).sort().join())return null;
 return Object.values(value.rules).every(r=>keys(r)===counters.join()&&counters.every(c=>count(r[c])))?value:null;
}
function readGuard(dir,kind) {
 let fd;
 try{
  fd=fs.openSync(path.join(dir,KINDS[kind].file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_FILE_BYTES)return {state:'invalid'};
  const guard=validGuard(JSON.parse(fs.readFileSync(fd,'utf8')),kind);
  return guard?{state:'valid',guard}:{state:'invalid'};
 }catch(e){return {state:e?.code==='ENOENT'?'absent':'invalid'};}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
function writeGuard(dir,kind,guard) {
 const file=path.join(dir,KINDS[kind].file),temp=`${file}.${process.pid}.tmp`;
 fs.writeFileSync(temp,`${JSON.stringify(guard)}\n`,{mode:0o600,flag:'wx'});
 try{fs.renameSync(temp,file);}catch(e){fs.rmSync(temp,{force:true});throw e;}
}
function outputBytes(input) {
 const r=input.tool_response;
 return bytes(input.error)+(typeof r==='string'?bytes(r):r&&typeof r==='object'&&!Array.isArray(r)?Object.values(r).reduce((n,v)=>n+bytes(v),0):0);
}

/** Hook step for a shell result. Other commands touch no file; an off guard costs one open: no lock, no write. */
export async function outputGuardNote(input,eventName,host,env=process.env) {
 if(!['PostToolUse','PostToolUseFailure'].includes(eventName)||input?.tool_name!=='Bash'||typeof input.tool_input?.command!=='string')return null;
 const command=input.tool_input.command.slice(0,MAX_COMMAND_CHARS),match=classify(command);
 if(!match)return null;
 const {kind,rule}=match,{PLUGIN_DATA:data,PLUGIN_ROOT:root}=hookEnvironment(env,host);
 if(!safe(data)||!safe(root))return null;
 const dir=path.join(data,STATE_DIR_NAME),stored=safeStateDirectory(dir)&&readGuard(dir,kind).guard?.enabled===true;
 // SOMESTOKEN_READ_GUARD=on|off switches the read guard for one process (paired experiments);
 // it wins over the file, and only file-switched runs are counted, so it never writes state.
 const switched=env.SOMESTOKEN_READ_GUARD;
 if(!(kind==='reads'&&(switched==='on'||switched==='off')?switched==='on':stored))return null;
 // A test run already using the compact recipe is counted, not nudged; reads have no compact form.
 const compact=kind==='tests'&&COMPACT.test(command),nudge=!compact&&outputBytes(input)>=MIN_OUTPUT_BYTES;
 if(stored)try{
  await withLock(dir,()=>{const {guard}=readGuard(dir,kind);if(!guard?.enabled)return;const r=guard.rules[rule];r.runs++;if(compact)r.compact++;if(nudge)r.nudged++;writeGuard(dir,kind,guard);});
 }catch{ /* counting is best effort; the note does not depend on it */ }
 return nudge?guardNote(rule,host,root,data):null;
}

/** optimization.mjs output guard enable|disable|status --host codex|claude [--kind tests|reads] [--json] */
export async function runOutputGuardCommand(args,env=process.env) {
 try{
  const [action,...rest]=args;let host,kind;
  if(!['enable','disable','status'].includes(action))throw Error('invalid_output_action');
  for(let i=0;i<rest.length;i++){
   if(rest[i]==='--host'&&host===undefined&&['codex','claude'].includes(rest[i+1]))host=rest[++i];
   else if(rest[i]==='--kind'&&kind===undefined&&Object.hasOwn(KINDS,rest[i+1]??''))kind=rest[++i];
   else if(rest[i]!=='--json')throw Error('invalid_output_options');
  }
  if(!host)throw Error('invalid_output_host');
  kind??='tests';
  const data=hookEnvironment(env,host).PLUGIN_DATA;if(!safe(data))throw Error('plugin_data_unavailable');
  const dir=path.join(data,STATE_DIR_NAME);
  if(action!=='status')await withLock(dir,()=>writeGuard(dir,kind,{schema:1,enabled:action==='enable',rules:readGuard(dir,kind).guard?.rules??fresh(kind)}));
  const {state,guard}=safeStateDirectory(dir)?readGuard(dir,kind):{state:'absent'};
  process.stdout.write(`${JSON.stringify({ok:true,enabled:guard?.enabled===true,state,rules:guard?.rules??null})}\n`);
 }catch(e){
  const known=new Set(['invalid_output_action','invalid_output_options','invalid_output_host','plugin_data_unavailable']);
  process.stderr.write(`SomesToken output guard · ${humanLabel(known.has(e.message)?e.message:'output_unavailable')} · Next: use optimization.mjs --help.\n`);process.exitCode=2;
 }
}
