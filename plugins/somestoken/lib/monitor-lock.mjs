import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const same=(a,b)=>a && b && a.dev===b.dev && a.ino===b.ino;
function owner(file) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.size>256)return null;
    const buffer=Buffer.alloc(257);let used=0,n;
    while(used<buffer.length&&(n=fs.readSync(fd,buffer,used,buffer.length-used,null)))used+=n;
    if(used>256)return null;
    const value=JSON.parse(buffer.subarray(0,used).toString('utf8'));
    // Runtime state locks before beta70 recorded only the pid; such a lock is
    // reaped when its owner is dead but never released as ours.
    return Number.isSafeInteger(value.pid)&&value.pid>0&&value.pid<=2147483647&&(value.token===undefined||typeof value.token==='string')
      ? {...value,stat}:null;
  }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function dead(value) {
  if(!value)return false;
  // Fail closed for a live (including reused) PID or an inaccessible process.
  // Neither lock age nor a PID alone can authorize releasing another owner.
  try{process.kill(value.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function release(file,held) {
  try {
    const current=owner(file);
    if(same(current?.stat,held.stat)&&current.token===held.token)fs.unlinkSync(file);
  }catch{/* Missing or replaced ownership is never ours to release. */}
  finally{fs.closeSync(held.fd);}
}
function acquire(file,depth=0) {
  const token=randomUUID(),candidate=`${file}.candidate-${token}`;
  let fd,held;
  try {
    fd=fs.openSync(candidate,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));
    fs.linkSync(candidate,file);
    held={fd,stat:fs.fstatSync(fd),token};
    return held;
  }catch(error) {
    if(error.code!=='EEXIST')throw error;
    const previous=owner(file);
    if(depth<3 && dead(previous)) {
      // Match the runtime lock protocol: serialize reapers of this inode so
      // two stale observers cannot remove a newly published successor lock.
      const id=createHash('sha256').update(`${previous.stat.dev}:${previous.stat.ino}`).digest('hex').slice(0,20);
      const claim=`${file}.reap-${id}`,reaper=acquire(claim,depth+1);
      if(reaper)try {
        const current=owner(file);
        if(same(previous.stat,current?.stat)&&current.token===previous.token&&dead(current))fs.unlinkSync(file);
      }finally{release(claim,reaper);}
    }
    return null;
  }finally {
    try{if(fd!==undefined&&same(fs.lstatSync(candidate),fs.fstatSync(fd)))fs.unlinkSync(candidate);}
    catch{/* A missing or replaced candidate is never ours to remove. */}
    finally{if(!held&&fd!==undefined)fs.closeSync(fd);}
  }
}
export function acquireStoreLock(directory,name='monitor.lock') {
  if(!['monitor.lock','feed.lock','profiles.lock'].includes(name))throw new Error('invalid_store_lock');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.lstatSync(directory).isSymbolicLink())throw new Error('unsafe-store');
  const file=path.join(directory,name);
  const held=acquire(file)??acquire(file);
  if(!held)throw new Error('monitor_already_running');
  let released=false;
  return ()=>{if(!released){released=true;release(file,held);}};
}
export {acquireStoreLock as acquireMonitorLock};
export {acquire as acquireFileLock,release as releaseFileLock};
