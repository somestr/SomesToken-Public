import {workspaceSnapshotSignature} from './workspace-store.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {registeredClaudeSourceInputs} from './claude-workspace.mjs';

// Metadata only. A changed, replaced, missing or unreadable source must wake
// the real reader; this probe never interprets a transcript or usage counter.
export function monitorInputs({codexRoot,claudeRoot,projectRoot,directory}) {
  const inputs=crypto.createHash('sha256'),outputs=crypto.createHash('sha256');
  let entries=0;
  const stamp=(file,hash,{optional=false}={})=>{
    if(++entries>60000)throw new Error('inventory_bound');
    try{
      const s=fs.lstatSync(file);
      if(!s.isSymbolicLink()&&!s.isFile()&&!s.isDirectory())throw new Error('unsafe_input');
      // Enumerated children carry their own stamps. Directory mtimes also
      // change for our temporary publication files and are not user activity.
      hash.update(JSON.stringify(s.isDirectory()?[file,s.dev,s.ino,s.mode]:[file,s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.mode]));
      return s;
    }catch(error){if(optional&&error.code==='ENOENT'){hash.update(JSON.stringify([file,'absent']));return null;}throw error;}
  };
  const visit=(root,hash,depth,accept,optional=false)=>{
    const stat=stamp(root,hash,{optional});if(!stat)return;
    if(!stat.isDirectory())throw new Error('invalid_root');
    const names=fs.readdirSync(root,{withFileTypes:true});
    if(names.length>20000)throw new Error('inventory_bound');
    for(const item of names.sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(root,item.name);
      // The reader excludes symlinks. Track their identity without following
      // them so a known exclusion does not force an expensive scan every tick.
      if(item.isSymbolicLink())stamp(file,hash);
      else if(item.isDirectory()){if(depth>0)visit(file,hash,depth-1,accept);}
      else if(accept(item.name))stamp(file,hash);
    }
  };
  try{
    if(!codexRoot&&!claudeRoot)return null;
    if(codexRoot)visit(codexRoot,inputs,3,name=>name.endsWith('.jsonl')||name.endsWith('.jsonl.zst'));
    if(claudeRoot){
      // Natural hooks replace their authorization entry even for Stop events
      // without a transcript append. Refresh-generated numeric feeds are
      // tracked separately so our own writes cannot keep the service awake.
      visit(path.join(claudeRoot,'.authorized-sources'),inputs,0,name=>name.endsWith('.json'),true);
      visit(path.join(claudeRoot,'.statusline'),inputs,0,name=>name.endsWith('.json'),true);
      for(const file of registeredClaudeSourceInputs(claudeRoot)){
        stamp(file,inputs,{optional:true});
        if(file.endsWith('.jsonl'))visit(path.join(path.dirname(file),path.basename(file,'.jsonl'),'subagents'),inputs,0,name=>name.endsWith('.jsonl'),true);
      }
      if(projectRoot)visit(projectRoot,inputs,4,name=>name.endsWith('.jsonl'),true);
      visit(claudeRoot,outputs,0,name=>/^[a-f0-9]{20}-\d+-[a-f0-9]+\.json$/.test(name));
    }
    stamp(path.join(directory,'task-profiles.json'),inputs,{optional:true});
    return {inputs:inputs.digest('hex'),outputs:outputs.digest('hex'),snapshot:workspaceSnapshotSignature(directory)};
  }catch{return null;}
}
