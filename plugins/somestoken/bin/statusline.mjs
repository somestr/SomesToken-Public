#!/usr/bin/env node
import { readPublicSnapshot } from '../lib/public/read.mjs';
import { formatStatusLine, fitStatusLine, statusLineFeasibility,captureClaudeStatus } from '../lib/hosts/claude-statusline.mjs';
import {configuredClaudeWorkspaceRoot} from '../lib/claude-workspace.mjs';

if(process.argv.includes('--help')) {process.stdout.write("SomesToken statusline · show compact recorded usage; --capture reads host JSON from stdin with explicit feed consent.\nWidth follows terminal columns or COLUMNS, up to 256 columns. Truncated segments end in an ellipsis.\n");process.exit(0);}
const width={columns:process.stdout.columns??process.env.COLUMNS};
if(process.argv.includes('--capture')) {
  const root=configuredClaudeWorkspaceRoot(process.env);
  let input='',bytes=0;
  if(root)await new Promise(resolve=>{
    const timer=setTimeout(()=>{process.stdin.destroy();resolve();},1000);
    process.stdin.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){input='';clearTimeout(timer);process.stdin.destroy();resolve();}else input+=chunk;});
    process.stdin.on('end',()=>{clearTimeout(timer);resolve();});process.stdin.on('error',()=>{clearTimeout(timer);resolve();});
  });
  let result;
  try{result=root&&input?captureClaudeStatus(JSON.parse(input),root):null;}catch{/* Capture failures never block a host turn. */}
  const r=result?.record;
  const quota=r?.quota_windows.map(q=>`${q.window_id==='five_hour'?'5h':'7d'} ${q.used_percent.toLocaleString('en-US',{maximumFractionDigits:2,useGrouping:false})}% used`)??[];
  const model=r?.configured_model==='unknown'?'model unavailable':r?.configured_model,effort=r?.configured_effort==='unknown'?'effort unavailable':r?.configured_effort;
  process.stdout.write(fitStatusLine(r?['SomesToken',...quota,`${model}/${effort}`]:['SomesToken','host usage unavailable','next: check diagnostics'],width)+'\n');
  process.exit(0);
}

const feasibility = statusLineFeasibility(process.env);
if (feasibility.status === 'unavailable') {
  process.stdout.write(fitStatusLine(['SomesToken','usage unavailable','next: check diagnostics'],width)+'\n');
  process.exit(0);
}
const result = readPublicSnapshot(process.env);
process.stdout.write(formatStatusLine(result.status==='bridge_ready'?result.snapshot:null,width)+'\n');
