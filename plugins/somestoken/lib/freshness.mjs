const timestamp=value=>Number.isSafeInteger(value)&&value>0?value:0;

export function workspaceFreshness(observedAt,now=Date.now(),maxAgeMs=120000) {
 if(!timestamp(observedAt)||!timestamp(now))return {status:'unavailable',age_ms:null,stale:true};
 if(observedAt>now)return {status:'clock_anomaly',age_ms:null,stale:true};
 const age_ms=now-observedAt,stale=age_ms>maxAgeMs;
 return {status:stale?'stale':'fresh',age_ms,stale};
}

export function collectorMaxAge(health={}) {
 const interval=health.interval_seconds;
 // A pending capture has its own bounded deadline, not an idle schedule lease.
 return health.status==='capturing'?120000:
  Math.max(120000,Number.isSafeInteger(interval)&&interval>=15&&interval<=3600?interval*1000+120000:0);
}

export function collectorFreshness(health={},now=Date.now()) {
 const at=health.status==='capturing'?timestamp(health.last_attempt_at):
  Math.max(...['last_attempt_at','last_success_at','last_snapshot_at',...(health.mode==='scheduled'?['last_checked_at']:[])].map(k=>timestamp(health[k])));
 return {...workspaceFreshness(at,now,collectorMaxAge(health)),observed_at:at};
}
