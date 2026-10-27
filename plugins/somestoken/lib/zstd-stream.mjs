import {Worker} from 'node:worker_threads';

// The ledger parser is synchronous and zlib only streams asynchronously, so a
// worker inflates into one shared slot while the caller blocks between chunks.
// The worker opens the file itself and refuses it unless dev/ino still match.
// ponytail: one 1 MiB slot moves about 60 MB/s and each worker takes about
// 100 ms to start; only rollouts over the one-shot bound come here. Use two
// slots if that ever matters. A worker that times out is terminated, and its
// descriptor can stay open until the process exits.
const SLOT=1024*1024,READY=1,END=2,FAILED=3,CANCEL=4;
const WORKER=`
const {workerData:{file,dev,ino,shared}}=require('node:worker_threads');
const fs=require('node:fs'),zlib=require('node:zlib'),{pipeline}=require('node:stream');
const state=new Int32Array(shared,0,2),data=new Uint8Array(shared,8);
const publish=part=>{
  data.set(part);Atomics.store(state,1,part.length);
  if(Atomics.compareExchange(state,0,0,${READY})!==0)return false;
  Atomics.notify(state,0);Atomics.wait(state,0,${READY});return Atomics.load(state,0)===0;
};
(async()=>{
  let inflate;
  try{
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.dev!==dev||stat.ino!==ino){fs.closeSync(fd);throw new Error('replaced');}
    inflate=zlib.createZstdDecompress({chunkSize:${SLOT}});
    pipeline(fs.createReadStream(null,{fd,highWaterMark:${SLOT}}),inflate,()=>{});
    for await(const chunk of inflate)for(let at=0;at<chunk.length;at+=${SLOT})if(!publish(chunk.subarray(at,at+${SLOT})))return inflate.destroy();
    if(Atomics.compareExchange(state,0,0,${END})===0)Atomics.notify(state,0);
  }catch{inflate?.destroy();if(Atomics.compareExchange(state,0,0,${FAILED})===0)Atomics.notify(state,0);}
})();`;

// Yields views of the shared slot; each is valid only until the next step.
export function* zstdChunks(file,stat,timeoutMs=60000){
  const shared=new SharedArrayBuffer(8+SLOT),state=new Int32Array(shared,0,2),data=Buffer.from(shared,8);
  const worker=new Worker(WORKER,{eval:true,workerData:{file,dev:stat.dev,ino:stat.ino,shared}});
  worker.on('error',()=>{});worker.unref();
  try{
    for(;;){
      if(Atomics.wait(state,0,0,timeoutMs)==='timed-out'){worker.terminate();throw new Error('inflate-timeout');}
      const value=Atomics.load(state,0);
      if(value===END)return;
      if(value!==READY)throw new Error('inflate-failed');
      yield data.subarray(0,Atomics.load(state,1));
      Atomics.store(state,0,0);Atomics.notify(state,0);
    }
  }finally{if(Atomics.load(state,0)!==END){Atomics.store(state,0,CANCEL);Atomics.notify(state,0);}}
}
