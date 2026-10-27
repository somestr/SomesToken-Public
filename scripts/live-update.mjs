#!/usr/bin/env node
// Compatibility paths only; loaded MCP processes remain owned by the host.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {REQUIRED_ENTRIES,packageEntriesForHost,MAX_ENTRY_UNCOMPRESSED_BYTES,MAX_TOTAL_UNCOMPRESSED_BYTES} from './package-check.mjs';
import {packageArtifactName,readPackageFile} from './plugin-manifest.mjs';
import {unlinkOwnedFile} from '../plugins/somestoken/lib/host-paths.mjs';

export const validVersion=v=>typeof v==='string'&&Boolean(packageArtifactName({name:'somestoken',version:v}));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const stat = p => {try{return fs.lstatSync(p);}catch(e){if(e.code!=='ENOENT')throw e;return null;}};
function temporaryDirectory(prefix){
  const directory=fs.mkdtempSync(prefix);return {directory,identity:fs.lstatSync(directory)};
}
function ownsDirectory(record){
  const entry=stat(record.directory);return entry?.isDirectory()&&entry.dev===record.identity.dev&&entry.ino===record.identity.ino;
}
function assertTemporary(record){
  safePath(record.directory);if(!ownsDirectory(record))throw Error('live_update_temporary_replaced');
}
function removeTemporary(record){
  if(ownsDirectory(record)){safePath(record.directory);fs.rmSync(record.directory,{recursive:true,force:true});}
}
function writeTemporary(file,data,mode=0o600){
  const descriptor=fs.openSync(file,'wx',mode);
  let owned;
  try{owned=fs.fstatSync(descriptor);fs.writeFileSync(descriptor,data);return fs.fstatSync(descriptor);}
  catch(error){unlinkOwnedFile(file,owned);throw error;}finally{fs.closeSync(descriptor);}
}
function assertTemporaryFile(file,identity){
  const entry=stat(file);
  if(!entry||entry.dev!==identity.dev||entry.ino!==identity.ino||entry.size!==identity.size||entry.mtimeMs!==identity.mtimeMs||entry.ctimeMs!==identity.ctimeMs)throw Error('live_update_temporary_replaced');
}
// Check every existing ancestor, including dangling links, before any mutation.
function safePath(p, allowLink=false) {
  const absolute=path.resolve(p);
  for(let current=absolute;;current=path.dirname(current)){
    const entry=stat(current);
    if(entry?.isSymbolicLink()&&!(current===absolute&&allowLink))throw Error('destination_symlink');
    if(current!==absolute&&entry&&!entry.isDirectory())throw Error('destination_not_directory');
    if(path.dirname(current)===current)break;
  }
}
const sourceEntries=new Set(REQUIRED_ENTRIES);
function files(root, {prefix='',ignored=new Set(),validateSource=false,budget={bytes:0},directories=null}={}) {
  safePath(root);if(directories)directories.set(root,fs.lstatSync(root));
  const result=[];
  for(const name of fs.readdirSync(root).sort()){
    // Claude's own cache markers: deleting .orphaned_at would stop old versions from ageing out.
    if(['.git','.somestoken-public','dist','node_modules','.DS_Store','.orphaned_at','.in_use','.claude-plugin-link'].includes(name))continue;
    const from=path.join(root,name),relative=path.posix.join(prefix,name),entry=fs.lstatSync(from);
    if(/(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.md|.*\.(?:pem|key|p12|pfx|crt|cer|log|sqlite|db))$/i.test(relative))throw Error('package_sensitive_file');
    if(ignored.has(from))continue;
    if(entry.isSymbolicLink())throw Error('package_symlink_excluded');
    if(entry.isDirectory()){
      if(validateSource&&!REQUIRED_ENTRIES.some(name=>name.startsWith(relative+'/')))throw Error('package_directory_not_allowlisted');
      result.push(...files(from,{prefix:relative,ignored,validateSource,budget,directories}));
    }else if(entry.isFile()){
      if(validateSource&&!sourceEntries.has(relative))throw Error('package_file_not_allowlisted');
      const data=readPackageFile(from,Math.min(MAX_ENTRY_UNCOMPRESSED_BYTES,MAX_TOTAL_UNCOMPRESSED_BYTES-budget.bytes),entry);budget.bytes+=data.length;
      result.push({name:relative,data,mode:entry.mode&0o777});
    }
    else throw Error('package_special_file');
  }
  return result;
}
const hash=entries=>crypto.createHash('sha256').update(Buffer.concat(entries.flatMap(e=>[Buffer.from(e.name+'\0'+e.data.length+'\0'),e.data]))).digest('hex');
const codexExcluded=new Set(REQUIRED_ENTRIES.filter(name=>!packageEntriesForHost('codex').includes(name)));
const claudeExcluded=new Set(REQUIRED_ENTRIES.filter(name=>!packageEntriesForHost('claude').includes(name)));
const MAX_CLAUDE_COMPAT_VERSIONS=32;

const liveOwners=new WeakMap();
function acquireLiveLock(codexHome){
  const directory=path.resolve(codexHome,'somestoken');safePath(directory);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const lock=path.join(directory,'.live-update.lock');
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('live_update_in_progress');throw error;}
  const owner={},token=crypto.randomUUID(),identity=fs.lstatSync(lock);
  let ownerIdentity;
  try{fs.writeFileSync(path.join(lock,'owner'),token,{mode:0o600,flag:'wx'});ownerIdentity=fs.lstatSync(path.join(lock,'owner'));}
  catch(error){fs.rmdirSync(lock);throw error;}
  liveOwners.set(owner,{lock,token,ownerIdentity,dev:identity.dev,ino:identity.ino,directory});
  return owner;
}
function assertLiveOwner(owner,codexHome){
  const record=liveOwners.get(owner);
  if(!record)throw Error('live_update_transaction_closed');
  if(record.directory!==path.resolve(codexHome,'somestoken'))throw Error('live_update_owner_mismatch');
  safePath(record.lock);
  const identity=stat(record.lock);
  if(!identity?.isDirectory()||identity.dev!==record.dev||identity.ino!==record.ino)throw Error('live_update_owner_mismatch');
  try{if(readPackageFile(path.join(record.lock,'owner'),36,record.ownerIdentity).toString('utf8')!==record.token)throw Error();}
  catch{throw Error('live_update_owner_mismatch');}
  return record;
}
function releaseLiveLock(owner,codexHome){
  const record=assertLiveOwner(owner,codexHome);
  const file=path.join(record.lock,'owner');unlinkOwnedFile(file,record.ownerIdentity);
  if(stat(file))throw Error('live_update_owner_mismatch');
  fs.rmdirSync(record.lock);liveOwners.delete(owner);
}
export function refreshLiveInstall(options={}){
  const home=fs.realpathSync(options.home||os.homedir()),codexHome=options.codexHome||path.join(home,'.codex');
  const nested=Boolean(options.transactionOwner),owner=options.transactionOwner||acquireLiveLock(codexHome);
  let retain=false;
  try{
    assertLiveOwner(owner,codexHome);
    return refreshLocked({...options,home,codexHome});
  }catch(error){retain=error.result?.rollback_status==='failed';throw error;}
  finally{if(!nested&&!retain)releaseLiveLock(owner,codexHome);}
}
function refreshLocked({home=os.homedir(),codexHome=path.join(home,'.codex'),source=path.resolve('plugins/somestoken'),compat=[],claudeCompat=[],beforeMutation,preflightOnly=false}={}) {
  home=fs.realpathSync(home);
  // Enforce the release boundary only on incoming source, before reading bytes.
  // Destination inventory must still include obsolete files from older installs.
  const entries=files(source,{validateSource:true});
  const manifest=JSON.parse(entries.find(e=>e.name==='.codex-plugin/plugin.json')?.data);
  if(typeof manifest?.version!=='string'||!packageArtifactName(manifest)||compat.some(v=>!validVersion(v))||claudeCompat.some(v=>!validVersion(v)))throw Error('invalid_plugin_version');
  if(claudeCompat.length>MAX_CLAUDE_COMPAT_VERSIONS)throw Error('too_many_claude_compat_versions');
  const cache=path.join(codexHome,'plugins/cache/somestoken-local/somestoken');
  const installed=path.join(cache,manifest.version);
  safePath(installed);
  const expected=entries.filter(e=>!codexExcluded.has(e.name));
  if(!preflightOnly){
    const actual=files(installed).filter(e=>!codexExcluded.has(e.name));
    if(hash(expected)!==hash(actual))throw Error('official_install_digest_mismatch');
  }
  const directory=path.join(codexHome,'somestoken'),registry=path.join(directory,'live-update.json');
  safePath(registry);
  let prior=[],priorClaude=[];
  if(stat(registry)){
    const r=JSON.parse(readPackageFile(registry));
    prior=Array.isArray(r.compat_versions)?r.compat_versions.filter(validVersion):[];
    priorClaude=Array.isArray(r.claude_compat_versions)?[...new Set(r.claude_compat_versions.filter(validVersion))]:[];
    if(priorClaude.length>MAX_CLAUDE_COMPAT_VERSIONS)throw Error('too_many_claude_compat_versions');
  }
  const versions=[...new Set([...prior,...compat,...fs.readdirSync(cache).filter(validVersion)])];
  const claudeCache=path.join(home,'.claude/plugins/cache/somestoken-local/somestoken');
  // A registered version whose Claude directory is gone can never receive files
  // again. Such entries are dropped only when the cap would otherwise be reached
  // (one slot stays free for the current version); explicit requests still fail closed.
  if(new Set([...priorClaude,...claudeCompat]).size>=MAX_CLAUDE_COMPAT_VERSIONS)
    priorClaude=priorClaude.filter(version=>claudeCompat.includes(version)||stat(path.join(claudeCache,version))?.isDirectory()===true);
  // Claude removes a version it marked orphaned two weeks later, so until then the
  // oldest marked ones make room; an unmarked or explicitly requested one never does.
  for(let index=0;index<priorClaude.length&&new Set([...priorClaude,...claudeCompat]).size>=MAX_CLAUDE_COMPAT_VERSIONS;){
    const version=priorClaude[index];
    if(!claudeCompat.includes(version)&&stat(path.join(claudeCache,version,'.orphaned_at'))?.isFile())priorClaude.splice(index,1);
    else index++;
  }
  const claudeCompatVersions=[...new Set([...priorClaude,...claudeCompat])];
  if(claudeCompatVersions.length>MAX_CLAUDE_COMPAT_VERSIONS)throw Error('too_many_claude_compat_versions');
  const stable=path.join(directory,'plugin'),launcher=path.join(home,'.local/bin/somestoken');
  safePath(stable,true);safePath(launcher);
  if(stat(stable)&&!stat(stable).isSymbolicLink())throw Error('stable_path_not_symlink');
  if(stat(launcher)&&(!stat(launcher).isFile()||!readPackageFile(launcher).toString('utf8').includes('# SomesToken managed launcher')))throw Error('launcher_conflict');
  let originalVersion=null;
  try{originalVersion=JSON.parse(readPackageFile(path.join(stable,'.codex-plugin/plugin.json'))).version;}catch{}
  const linked=[],preserved=[],operations=[];
  const add=(target,data,mode=0o600,link=false)=>{safePath(target,link);const entry=stat(target);if(entry&&!entry.isFile()&&!(link&&entry.isSymbolicLink()))throw Error('destination_type_conflict');operations.push({target,data,mode,link});};
  for(const version of versions){
    if(version===manifest.version)continue;
    const target=path.join(cache,version);safePath(target,true);
    if(stat(target)&&!stat(target).isSymbolicLink()){if(!stat(target).isDirectory())throw Error('destination_type_conflict');preserved.push(version);continue;}
    add(target,stable,0,true);linked.push(version);
  }
  add(launcher,'#!/bin/sh\n# SomesToken managed launcher\nexec '+quote(process.execPath)+' '+quote(path.join(stable,'bin/console.mjs'))+' "$@"\n',0o755);
  let claudeUpdated=false;
  const claudeTargets=[],claudeCompatibility=[],claudeApplied=[];
  let currentClaudeVersion=null,currentClaudeValidated=false;
  const claudeManifest=entries.find(e=>e.name==='.claude-plugin/plugin.json');
  if(claudeManifest){
    let sourceClaudeManifest;
    try{sourceClaudeManifest=JSON.parse(claudeManifest.data);}catch{throw Error('invalid_claude_manifest');}
    const version=sourceClaudeManifest.version;
    if(typeof version!=='string'||!packageArtifactName(sourceClaudeManifest))throw Error('invalid_claude_version');
    currentClaudeVersion=version;
    const baseDesired=entries.filter(e=>!claudeExcluded.has(e.name));
    for(const destinationVersion of [version,...claudeCompatVersions.filter(value=>value!==version)]){
      const claude=path.join(claudeCache,destinationVersion);safePath(claude);
      const destinationStat=stat(claude);
      if(!destinationStat)continue;
      if(!destinationStat.isDirectory())throw Error('destination_type_conflict');
      const old=files(claude); // Includes every destination file, including obsolete runtime files.
      const oldManifestEntry=old.find(entry=>entry.name==='.claude-plugin/plugin.json');
      let oldManifest;
      try{oldManifest=JSON.parse(oldManifestEntry?.data);}catch{throw Error(destinationVersion===version?'claude_install_manifest_invalid':'claude_compat_manifest_invalid');}
      if(oldManifest?.name!==sourceClaudeManifest.name||oldManifest.version!==destinationVersion){
        throw Error(destinationVersion===version?'claude_install_identity_mismatch':'claude_compat_identity_mismatch');
      }
      const compatibility=destinationVersion!==version;
      const desired=compatibility?baseDesired.map(entry=>entry.name==='.claude-plugin/plugin.json'
        ?{...entry,data:Buffer.from(JSON.stringify({...sourceClaudeManifest,version:destinationVersion}))}:entry):baseDesired;
      const packageDigest=hash(desired);
      claudeTargets.push({root:claude,digest:packageDigest});
      claudeApplied.push({version:destinationVersion,source_version:version,package_digest:packageDigest});
      for(const entry of desired)add(path.join(claude,entry.name),entry.data,entry.mode);
      for(const entry of old)if(!desired.some(e=>e.name===entry.name))add(path.join(claude,entry.name),null);
      if(compatibility)claudeCompatibility.push({version:destinationVersion,source_version:version,package_digest:packageDigest});
      else currentClaudeValidated=true;
      claudeUpdated=true;
    }
  }
  let claudeStatusline='not_installed';
  if(claudeUpdated){
    const settingsPath=path.join(home,'.claude/settings.json');safePath(settingsPath);
    const settings=stat(settingsPath)?JSON.parse(readPackageFile(settingsPath)):{};
    if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('invalid_claude_settings');
    const command=quote(process.execPath)+' '+quote(path.join(stable,'bin/statusline.mjs'))+' --capture';
    if(settings.statusLine===undefined||settings.statusLine?.command===command){
      if(settings.statusLine?.type!=='command'||settings.statusLine?.refreshInterval!==30){
        add(settingsPath,JSON.stringify({...settings,statusLine:{...settings.statusLine,type:'command',command,refreshInterval:30}},null,2)+'\n');
      }
      claudeStatusline='configured';
    }else claudeStatusline='existing_custom_preserved';
  }
  // Activate the stable path last, after every package file has been staged.
  add(stable,installed,0,true);
  const claudeCompatRegistered=[...new Set([...claudeCompatVersions,...(currentClaudeValidated?[currentClaudeVersion]:[])])];
  if(claudeCompatRegistered.length>MAX_CLAUDE_COMPAT_VERSIONS)throw Error('too_many_claude_compat_versions');
  const claudeCompatApplied=Object.fromEntries(claudeApplied.filter(entry=>claudeCompatRegistered.includes(entry.version))
    .map(entry=>[entry.version,{source_version:entry.source_version,package_digest:entry.package_digest}]));
  add(registry,JSON.stringify({version:manifest.version,compat_versions:versions,claude_compat_versions:claudeCompatRegistered,
    claude_compat_applied:claudeCompatApplied,updated_at:Date.now()}));
  const result={version:manifest.version,planned_version:manifest.version,verified_version:manifest.version,active_version:originalVersion,package_digest:hash(expected),package_digest_kind:'sha256_paths_and_bytes',activation_evidence:'files_only',stable,launcher,linked,preserved,claudeUpdated:false,claude_compatibility:claudeCompatibility,claude_compat_registered_versions:claudeCompatRegistered,claude_statusline:claudeStatusline,claude_package_atomic:false,observed_claude_hook_version:null,loaded_mcp_reload:'host_owned',task_restart_required:false,rollback_status:'not_needed',activation_status:'pending',package_atomic:false,interruption_recovery:'manual'};
  if(preflightOnly)return {...result,verified_version:null,activation_status:'preflight_passed'};
  const staged=[],applied=[],created=[];
  const ensureDirectory=directory=>{if(stat(directory))return;ensureDirectory(path.dirname(directory));safePath(directory);fs.mkdirSync(directory,{mode:0o700});created.push({directory,identity:fs.lstatSync(directory)});};
  try{
    ensureDirectory(directory);
    for(const operation of operations){
      safePath(operation.target,operation.link);ensureDirectory(path.dirname(operation.target));
      const entry=stat(operation.target);
      operation.backup=entry?{link:entry.isSymbolicLink(),data:entry.isSymbolicLink()?fs.readlinkSync(operation.target):readPackageFile(operation.target,MAX_ENTRY_UNCOMPRESSED_BYTES,entry),mode:entry.mode&0o777}:null;
      // mkdtemp reserves a private sibling namespace; no shared predictable file names.
      const staging=temporaryDirectory(path.join(path.dirname(operation.target),'.somestoken-update-')),temporary=staging.directory;
      staged.push(staging);operation.staging=staging;operation.temp=path.join(temporary,'next');
      if(operation.backup){
        fs.writeFileSync(path.join(temporary,'backup'),operation.backup.data,{mode:0o600,flag:'wx'});
        fs.writeFileSync(path.join(temporary,'recovery.json'),JSON.stringify({target:operation.target,link:operation.backup.link,mode:operation.backup.mode}),{mode:0o600,flag:'wx'});
      }
      if(operation.data!==null){
        if(operation.link){fs.symlinkSync(operation.data,operation.temp);operation.tempIdentity=stat(operation.temp);}
        else operation.tempIdentity=writeTemporary(operation.temp,operation.data,operation.mode);
      }
    }
    for(const operation of operations){
      beforeMutation?.(operation.target,applied.length);
      assertTemporary(operation.staging);
      if(operation.data!==null)assertTemporaryFile(operation.temp,operation.tempIdentity);
      if(operation.target===stable){
        if(hash(files(installed).filter(e=>!codexExcluded.has(e.name)))!==hash(expected))throw Error('official_install_digest_changed');
        if(claudeTargets.some(target=>hash(files(target.root,{ignored:new Set(staged.map(entry=>entry.directory))}))!==target.digest))throw Error('claude_install_digest_mismatch');
      }
      safePath(operation.target,operation.link);
      if(operation.data===null)fs.unlinkSync(operation.target);
      else fs.renameSync(operation.temp,operation.target);
      applied.push(operation);
    }
    result.active_version=manifest.version;result.claudeUpdated=claudeUpdated;result.activation_status='activated';
  }catch(error){
    let restored=true;
    for(const operation of applied.reverse()){
      try{
        safePath(operation.target,operation.link);
        if(operation.backup){
          assertTemporary(operation.staging);
          const recovery=path.join(path.dirname(operation.temp),'restore');
          if(operation.backup.link)fs.symlinkSync(operation.backup.data,recovery);
          else fs.writeFileSync(recovery,operation.backup.data,{mode:operation.backup.mode,flag:'wx'});
          fs.renameSync(recovery,operation.target);
        }else fs.unlinkSync(operation.target);
      }catch{restored=false;}
    }
    result.rollback_status=restored?'restored':'failed';result.activation_status=restored?'failed':'mixed_version';
    result.active_version=restored?originalVersion:null;
    if(!restored)result.recovery_directories=staged.map(entry=>entry.directory);
    error.result=result;throw error;
  }finally{
    if(result.rollback_status!=='failed')for(const temporary of staged)removeTemporary(temporary);
    for(const entry of created.reverse())try{if(ownsDirectory(entry)){safePath(entry.directory);fs.rmdirSync(entry.directory);}}catch{}
  }
  return result;
}
// Keep the previous cache outside the official installer's replacement scope.
// This protects failure recovery, not uninterrupted reads during host cache removal.
// A version's dist/ holds release archives, which are not part of the package
// (files() skips them) and are never loaded, so only the runtime is kept.
export function prepareOfficialInstall(options={}) {
  const home=fs.realpathSync(options.home||os.homedir());
  const codexHome=options.codexHome||path.join(home,'.codex');
  const owner=acquireLiveLock(codexHome);
  let backup=null,backupOwner=null,closed=false,retain=false;
  const assertOpen=()=>{if(closed)throw Error('live_update_transaction_closed');assertLiveOwner(owner,codexHome);if(backupOwner)assertTemporary(backupOwner);};
  try{
    const plan=refreshLiveInstall({...options,home,codexHome,preflightOnly:true,transactionOwner:owner});
    const cache=path.join(codexHome,'plugins/cache/somestoken-local/somestoken');
    const directory=path.join(codexHome,'somestoken');
    safePath(cache);safePath(directory);
    const snapshots=new Map(),directories=new Map([[cache,fs.lstatSync(cache)]]),links=new Map();
    // Existing compatibility links are allowed; package-internal links are not.
    for(const version of fs.readdirSync(cache)){
      const target=path.join(cache,version),entry=stat(target);
      if(entry.isDirectory())for(const file of files(target,{directories}))snapshots.set(path.join(target,file.name),file);
      else if(entry.isSymbolicLink())links.set(target,fs.readlinkSync(target));
      else throw Error('destination_type_conflict');
    }
    backupOwner=temporaryDirectory(path.join(directory,'.official-install-'));backup=backupOwner.directory;
    // Copy the directory skeleton and host markers; runtime bytes come from validation.
    fs.cpSync(cache,path.join(backup,'cache'),{recursive:true,verbatimSymlinks:true,filter:from=>{
      const parts=path.relative(cache,from).split(path.sep);
      if(parts.length===2&&parts[1]==='dist')return false;
      if(parts.slice(1).some(name=>['.git','.somestoken-public','dist','node_modules','.DS_Store','.orphaned_at','.in_use','.claude-plugin-link'].includes(name)))return true;
      if(snapshots.has(from))return false;
      const entry=stat(from),expected=directories.get(from);
      if(expected&&entry?.isDirectory()&&entry.dev===expected.dev&&entry.ino===expected.ino)return true;
      if(links.has(from)&&entry?.isSymbolicLink()&&fs.readlinkSync(from)===links.get(from))return true;
      throw Error('official_install_cache_changed');
    }});
    for(const [from,file] of snapshots){assertTemporary(backupOwner);writeTemporary(path.join(backup,'cache',path.relative(cache,from)),file.data,file.mode);}
    const managed=[plan.stable,plan.launcher,path.join(directory,'live-update.json')].map(target=>{
      safePath(target,target===plan.stable);
      const entry=stat(target);
      return {target,link:entry?.isSymbolicLink()||false,mode:entry?entry.mode&0o777:0o600,data:entry?(entry.isSymbolicLink()?fs.readlinkSync(target):readPackageFile(target,MAX_ENTRY_UNCOMPRESSED_BYTES,entry)):null};
    });
    return {
      refresh(){
        assertOpen();
        try{return refreshLiveInstall({...options,home,codexHome,preflightOnly:false,transactionOwner:owner});}
        catch(error){retain=error.result?.rollback_status==='failed';throw error;}
      },
      commit(){
        assertOpen();
        if(retain)throw Error('live_update_recovery_required');
        removeTemporary(backupOwner);releaseLiveLock(owner,codexHome);closed=true;
      },
      rollback(){
        assertOpen();
        try{
          safePath(cache);
          if(stat(cache))fs.renameSync(cache,path.join(backup,'failed-cache'));
          fs.renameSync(path.join(backup,'cache'),cache);
          for(let index=0;index<managed.length;index++){
            const entry=managed[index];safePath(entry.target,entry.link);
            if(entry.data===null){fs.rmSync(entry.target,{force:true});continue;}
            const temporary=path.join(backup,'restore-'+index);
            if(entry.link)fs.symlinkSync(entry.data,temporary);
            else fs.writeFileSync(temporary,entry.data,{mode:entry.mode,flag:'wx'});
            fs.renameSync(temporary,entry.target);
          }
          removeTemporary(backupOwner);
          if(!retain)releaseLiveLock(owner,codexHome);
          closed=true;
          return {rollback_status:retain?'failed':'restored',active_version:plan.active_version};
        }catch{closed=true;return {rollback_status:'failed',active_version:null,recovery_directory:backup};}
      },
    };
  }catch(error){
    if(backupOwner)removeTemporary(backupOwner);
    releaseLiveLock(owner,codexHome);throw error;
  }
}

export function prepareMonitorRuntime(plist,stable,{run=spawnSync}={}){
  safePath(plist);const input=readPackageFile(plist);
  const args=JSON.parse(run('/usr/bin/plutil',['-extract','ProgramArguments','json','-o','-','-'],{encoding:'utf8',input}).stdout);
  const directory=path.join(path.dirname(stable),'monitor-runtime');safePath(directory);
  const metadata=path.join(directory,'source.json');safePath(metadata);
  let executable=args?.[0];
  if(typeof executable!=='string')throw Error('monitor_arguments_invalid');
  if(path.basename(executable)==='SomesToken'){
    const entry=stat(metadata);
    if(!entry?.isFile()||entry.size>4096)throw Error('monitor_runtime_source_missing');
    executable=JSON.parse(readPackageFile(metadata,4096,entry)).executable;
  }
  if(typeof executable!=='string'||!path.isAbsolute(executable))throw Error('monitor_runtime_source_invalid');
  const source=fs.realpathSync(executable);safePath(source);
  const sourceEntry=stat(source);
  if(!sourceEntry?.isFile()||sourceEntry.size>256*1024*1024)throw Error('monitor_runtime_source_invalid');
  const sourceBytes=readPackageFile(source,256*1024*1024,sourceEntry),digest=crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const runtimeId=crypto.createHash('sha256').update(source+'\0'+digest).digest('hex').slice(0,20);
  const destination=path.join(directory,runtimeId),named=path.join(destination,'SomesToken');
  const dependencies=run('/usr/bin/otool',['-L',source],{encoding:'utf8'});
  if(dependencies.status!==0)throw Error('monitor_runtime_dependencies_unreadable');
  const libraries=new Map();
  for(const [,name] of dependencies.stdout.matchAll(/@rpath\/(libnode\.[A-Za-z0-9.]+\.dylib)/g)){
    const library=[path.join(path.dirname(source),name),path.resolve(path.dirname(source),'../lib',name)].find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
    if(!library)throw Error('monitor_runtime_library_missing');
    libraries.set(name,fs.realpathSync(library));
  }
  safePath(destination);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(!stat(destination)){
    const temporary=temporaryDirectory(path.join(directory,'.prepare-')),staging=temporary.directory;
    try{
      assertTemporary(temporary);
      const executableIdentity=writeTemporary(path.join(staging,'SomesToken'),sourceBytes,sourceEntry.mode&0o777);
      // Homebrew Node uses a small executable and a sibling libnode dylib.
      // Standalone Node needs no library link. Keep the original signed bytes.
      for(const [name,library] of libraries)fs.symlinkSync(library,path.join(staging,name));
      const check=run(path.join(staging,'SomesToken'),['--version'],{encoding:'utf8',timeout:10000});
      if(check.status!==0||!/^v\d+\.\d+\.\d+\s*$/.test(check.stdout))throw Error('monitor_runtime_validation_failed');
      assertTemporary(temporary);assertTemporaryFile(path.join(staging,'SomesToken'),executableIdentity);
      if(crypto.createHash('sha256').update(readPackageFile(path.join(staging,'SomesToken'),256*1024*1024,executableIdentity)).digest('hex')!==digest)throw Error('monitor_runtime_invalid');
      fs.renameSync(staging,destination);
    }finally{removeTemporary(temporary);}
  }
  safePath(named);
  const namedEntry=stat(named);
  if(!namedEntry?.isFile()||namedEntry.size!==sourceBytes.length||crypto.createHash('sha256').update(readPackageFile(named,256*1024*1024,namedEntry)).digest('hex')!==digest)throw Error('monitor_runtime_invalid');
  for(const [name,library] of libraries){
    const link=path.join(destination,name);
    if(!stat(link)?.isSymbolicLink()||fs.readlinkSync(link)!==library)throw Error('monitor_runtime_invalid');
  }
  const temporary=metadata+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  let owned;
  try{owned=writeTemporary(temporary,JSON.stringify({executable})+'\n');safePath(metadata);assertTemporaryFile(temporary,owned);fs.renameSync(temporary,metadata);}
  finally{unlinkOwnedFile(temporary,owned);}
  return named;
}

export function updateMonitorConfiguration(plist,stable,{run=spawnSync,executable=null}={}){
  safePath(plist);
  const entry=stat(plist),original=readPackageFile(plist,MAX_ENTRY_UNCOMPRESSED_BYTES,entry);
  const read=run('/usr/bin/plutil',['-extract','ProgramArguments','json','-o','-','-'],{encoding:'utf8',input:original});
  if(read.status!==0)throw Error('monitor_arguments_unreadable');
  const previous=JSON.parse(read.stdout);
  if(!Array.isArray(previous)||previous.some(a=>typeof a!=='string'))throw Error('monitor_arguments_invalid');
  const scriptIndex=previous.findIndex((arg,index)=>index>0&&!arg.startsWith('--'));
  if(scriptIndex<1)throw Error('monitor_arguments_invalid');
  const runtimeOptions=previous.slice(1,scriptIndex).filter(arg=>!/^--(?:max[-_]semi[-_]space[-_]size|optimize[-_]for[-_]size|heap[-_]growing[-_]percent)(?:=|$)/.test(arg));
  const options=previous.slice(scriptIndex+1).filter(a=>a.startsWith('--')&&!['--watch','--once','--scheduled'].includes(a));
  const interval=Number(options.find(a=>a.startsWith('--interval='))?.slice(11)??30);
  if(!Number.isSafeInteger(interval)||interval<15||interval>3600)throw Error('monitor_arguments_invalid');
  // Smaller young-generation allocation and size-oriented GC avoid growing a
  // large heap for short captures. Retained history has no imposed heap cap.
  const args=[executable??previous[0],...runtimeOptions,'--max-semi-space-size=1','--optimize-for-size','--heap-growing-percent=10',path.join(stable,'bin/monitor.mjs'),'--scheduled',...options];
  const staging=temporaryDirectory(path.join(path.dirname(plist),'.somestoken-monitor-')),directory=staging.directory;
  const stagedRun=(command,args,options)=>{assertTemporary(staging);return run(command,args,options);};
  try{
    const temporary=path.join(directory,'monitor.plist');writeTemporary(temporary,original,entry.mode&0o777);
    const update=stagedRun('/usr/bin/plutil',['-replace','ProgramArguments','-json',JSON.stringify(args),temporary]);
    if(update.status!==0)throw Error('monitor_configuration_failed');
    const cwd=stagedRun('/usr/bin/plutil',['-replace','WorkingDirectory','-string',stable,temporary]);
    if(cwd.status!==0)throw Error('monitor_directory_failed');
    for(const [key,type,value] of [['KeepAlive','bool','false'],['RunAtLoad','bool','true'],['StartInterval','integer',String(interval)]]){
      if(stagedRun('/usr/bin/plutil',['-replace',key,'-'+type,value,temporary]).status!==0)throw Error('monitor_configuration_failed');
    }
    const environment=stagedRun('/usr/bin/plutil',['-extract','EnvironmentVariables','json','-o','-',temporary],{encoding:'utf8'});
    const variables=environment.status===0?JSON.parse(environment.stdout):{};
    if(!variables||typeof variables!=='object'||Array.isArray(variables))throw Error('monitor_environment_invalid');
    if(stagedRun('/usr/bin/plutil',['-replace','EnvironmentVariables','-json',JSON.stringify({...variables,MallocSpaceEfficient:'1',MallocMaxMagazines:'1'}),temporary]).status!==0)throw Error('monitor_configuration_failed');
    assertTemporary(staging);readPackageFile(temporary);safePath(plist);fs.renameSync(temporary,plist);
  }finally{removeTemporary(staging);}
}

const MONITOR_LABEL='com.somestr.somestoken.monitor';
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
// launchctl can acknowledge bootout before teardown releases the service label.
// Allow the observed five-second exit grace period before abandoning a
// configuration. Activation plus rollback still waits less than 14 seconds.
function bootstrapMonitor(domain,plist,run,wait){
  let status=null;
  for(const delay of [0,100,250,500,1000,2000,3000]){
    if(delay)wait(delay);
    status=run('/bin/launchctl',['bootstrap',domain,plist]).status??null;
    if(status===0)break;
  }
  return status;
}

export function restartMonitor(plist,stable,{run=spawnSync,prepareRuntime=prepareMonitorRuntime,uid=process.getuid?.(),wait=sleep}={}){
  safePath(plist);
  const entry=stat(plist),original=readPackageFile(plist,MAX_ENTRY_UNCOMPRESSED_BYTES,entry),mode=entry.mode&0o777;
  const executable=prepareRuntime(plist,stable,{run});
  updateMonitorConfiguration(plist,stable,{run,executable});
  const domain='gui/'+uid;
  run('/bin/launchctl',['bootout',domain+'/'+MONITOR_LABEL]);
  const failedBootstrapStatus=bootstrapMonitor(domain,plist,run,wait);
  if(failedBootstrapStatus===0)return {monitor_restart:'started',monitor_snapshot_verification:'pending'};
  const staging=temporaryDirectory(path.join(path.dirname(plist),'.somestoken-monitor-')),directory=staging.directory;
  let restored=false;
  try{
    assertTemporary(staging);
    const temporary=path.join(directory,'restore.plist'),identity=writeTemporary(temporary,original,mode);
    assertTemporary(staging);assertTemporaryFile(temporary,identity);safePath(plist);fs.renameSync(temporary,plist);
    restored=bootstrapMonitor(domain,plist,run,wait)===0;
  }finally{removeTemporary(staging);}
  const error=Error('monitor_restart_failed');
  error.result={monitor_restart:'failed',monitor_rollback_status:restored?'restored':'failed',monitor_snapshot_verification:'unavailable',monitor_bootstrap_exit_code:failedBootstrapStatus};
  throw error;
}

/** Creates and loads the collector job when no job file exists; an existing file is only reported. */
export function installMonitor(plist,stable,{run=spawnSync,executable,environment={},logs,label=MONITOR_LABEL,monitorOptions=['--interval=30'],uid=process.getuid?.(),wait=sleep}={}){
  safePath(plist);safePath(logs);
  const domain='gui/'+uid;
  if(stat(plist))return {monitor_install:run('/bin/launchctl',['print',domain+'/'+label]).status===0?'existing':'existing_unloaded'};
  fs.mkdirSync(logs,{recursive:true,mode:0o700});fs.mkdirSync(path.dirname(plist),{recursive:true});
  const job={Label:label,ProgramArguments:[executable,path.join(stable,'bin/monitor.mjs'),...monitorOptions],EnvironmentVariables:environment,
    StandardOutPath:path.join(logs,'monitor.stdout.log'),StandardErrorPath:path.join(logs,'monitor.stderr.log')};
  const temporary=plist+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  let created=false;
  try{
    // launchd loads XML property lists; the link never replaces a job file created meanwhile.
    if(run('/usr/bin/plutil',['-convert','xml1','-o',temporary,'-'],{input:JSON.stringify(job)}).status!==0)throw Error('monitor_install_failed');
    fs.linkSync(temporary,plist);created=true;
    updateMonitorConfiguration(plist,stable,{run,executable});
    const status=bootstrapMonitor(domain,plist,run,wait);
    if(status===0)return {monitor_install:'started',monitor_snapshot_verification:'pending'};
    const error=Error('monitor_install_failed');error.result={monitor_install:'failed',monitor_bootstrap_exit_code:status};throw error;
  }catch(error){
    if(created){run('/bin/launchctl',['bootout',domain+'/'+label]);fs.rmSync(plist,{force:true});}
    throw error;
  }finally{fs.rmSync(temporary,{force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(!args.includes('--apply')||args.some(a=>a!=='--apply'&&!a.startsWith('--compat-version=')&&!a.startsWith('--claude-compat-version=')))throw Error('Use --apply [--compat-version=<version>] [--claude-compat-version=<version>] after official installation');
  const result=refreshLiveInstall({compat:args.filter(a=>a.startsWith('--compat-version=')).map(a=>a.slice(17)),
    claudeCompat:args.filter(a=>a.startsWith('--claude-compat-version=')).map(a=>a.slice(24))});
  // Refresh an existing monitor service only; never touch host/task processes.
  const plist=path.join(os.homedir(),'Library/LaunchAgents',MONITOR_LABEL+'.plist');
  if(process.platform==='darwin'&&fs.existsSync(plist)){
    try{Object.assign(result,restartMonitor(plist,result.stable));}
    catch(error){console.log(JSON.stringify({...result,...error.result}));throw error;}
  }
  console.log(JSON.stringify(result));
}
