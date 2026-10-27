// Native report contracts and invocation examples: skills/somestoken/references/optimization.md.
// Parse a bounded XML subset without DTDs, custom entities, network access or a retained tree.
const MAX_BYTES = 4 * 1024 * 1024;
const STATUSES = ['pass','fail','cancelled','skip','todo'];
export const TEST_REPORT_FORMATS = Object.freeze(['node-test-events-v1','junit-xml','go-test-json','trx-xml']);
export const MAX_TEST_REPORT_BYTES = MAX_BYTES;
const requireValue = condition => { if (!condition) throw Error('invalid_report'); };
const natural = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function accumulator(maxBytes) {
 const counts={tests:0,suites:0,...Object.fromEntries(STATUSES.map(s=>[s,0]))}, failures=[], other=[];
 let detailCount=0;
 return {counts, addTest(status){counts.tests++;counts[status]++;},
  add(label,text,priority=false,truncated=false){
   detailCount++;const target=priority?failures:other;
   if(target.length<8)target.push({label,text:String(text).slice(0,Math.min(maxBytes,2048)),truncated:truncated||String(text).length>Math.min(maxBytes,2048)});
  }, result(){return {counts,details:[...failures,...other].slice(0,8),detailCount};}};
}

function entities(text) {
 requireValue(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text));
 return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,(_,entity)=>{
  const names={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(entity in names)return names[entity];
  const n=entity.startsWith('#x')?parseInt(entity.slice(2),16):Number(entity.slice(1));
  requireValue(n===9||n===10||n===13||n>=32&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)&&n!==0xfffe&&n!==0xffff);
  return String.fromCodePoint(n);
 });
}

function walkXml(source,onStart,onEnd) {
 const stack=[];let offset=0,rootSeen=false,closed=false,nodes=0;
 const text=(value,child=false)=>{if(!stack.length){requireValue(!value.trim());return;}
  const f=stack.at(-1);if(!child&&value.trim())f.ownText=true;
  f.text+=value.slice(0,Math.max(0,2048-f.text.length));if(value.length+f.textLength>2048)f.clipped=true;f.textLength+=value.length;};
 while(offset<source.length){
  if(source[offset]!=='<'){
   const end=source.indexOf('<',offset),stop=end<0?source.length:end;
   const content=source.slice(offset,stop);requireValue(!content.includes(']]>'));text(entities(content));offset=stop;continue;
  }
  if(source.startsWith('<!--',offset)){const end=source.indexOf('-->',offset+4);requireValue(end>=0&&!source.slice(offset+4,end).includes('--'));offset=end+3;continue;}
  if(source.startsWith('<![CDATA[',offset)){const end=source.indexOf(']]>',offset+9);requireValue(end>=0&&stack.length>0);text(source.slice(offset+9,end));offset=end+3;continue;}
  if(source.startsWith('<?xml ',offset)){
   requireValue(!rootSeen&&offset===0);const end=source.indexOf('?>',offset);requireValue(end>=0);
   requireValue(!/encoding\s*=\s*['"](?!utf-8['"]|UTF-8['"])[^'"]+['"]/.test(source.slice(offset,end)));offset=end+2;continue;
  }
  const tag=/^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*)(\/?)>/.exec(source.slice(offset));
  requireValue(tag);offset+=tag[0].length;
  if(tag[1]){
   requireValue(!tag[3].trim()&&!tag[4]&&stack.at(-1)?.rawName===tag[2]);
   const frame=stack.pop();onEnd(frame,stack);
   if(stack.length){text(frame.text,true);if(frame.clipped)stack.at(-1).clipped=true;}else closed=true;
   continue;
  }
  requireValue(!closed&&stack.length<64&&++nodes<=100000);
  if(!stack.length){requireValue(!rootSeen);rootSeen=true;}
  const attrs=Object.create(null);
  for(const a of tag[3].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)){
   requireValue(!Object.hasOwn(attrs,a[1]));attrs[a[1]]=entities(a[2]??a[3]);
  }
  const frame={rawName:tag[2],name:tag[2].split(':').at(-1),attrs,text:'',textLength:0,clipped:false};
  onStart(frame,stack);stack.push(frame);
  if(tag[4]){stack.pop();onEnd(frame,stack);if(!stack.length)closed=true;}
 }
 requireValue(rootSeen&&closed&&!stack.length);
}

function junit(source,maxBytes) {
 const a=accumulator(maxBytes);let current=null;const observed={tests:0,failures:0,errors:0,skipped:0};
 const children={testsuites:['testsuite','testsuites'],testsuite:['testsuite','testsuites','testcase','properties','system-out','system-err'],
  testcase:['failure','error','skipped','system-out','system-err','properties'],properties:['property'],property:[],failure:[],error:[],skipped:[],'system-out':[],'system-err':[]};
 walkXml(source,(frame,stack)=>{
  const {name,attrs}=frame;
  requireValue(stack.length?(children[stack.at(-1).name]??[]).includes(name):['testsuite','testsuites'].includes(name));
  if(name==='testsuite'||name==='testsuites'){frame.before={...observed};if(name==='testsuite')a.counts.suites++;}
  if(name==='testcase'){requireValue(!current&&attrs.name?.trim());current={name:[attrs.classname,attrs.name].filter(Boolean).join('.'),status:'pass',failure:false,error:false};}
  if(['failure','error','skipped'].includes(name))requireValue(current);
 },(frame)=>{
  const {name,attrs}=frame;
  if(['testsuites','testsuite','testcase','properties'].includes(name))requireValue(!frame.ownText);
  if(['failure','error'].includes(name)){
   requireValue(current.status!=='skip');
   current.status='fail';current[name]=true;a.add(`FAIL ${current.name}`,`${attrs.message??''}\n${frame.text}`,true,frame.clipped);
  }else if(name==='skipped'){
   requireValue(current.status==='pass');current.status='skip';
   if(attrs.message||frame.text.trim())a.add(`SKIP ${current.name}`,`${attrs.message??''}\n${frame.text}`,false,frame.clipped);
  }else if(name==='system-out'||name==='system-err'){
   if(frame.text.trim())a.add(name.toUpperCase(),frame.text,false,frame.clipped);
  }else if(name==='testcase'){
   a.addTest(current.status);observed.tests++;observed.failures+=Number(current.failure);observed.errors+=Number(current.error);observed.skipped+=Number(current.status==='skip');current=null;
  }else if(frame.before){
   for(const key of Object.keys(observed))if(attrs[key]!==undefined)requireValue(natural(attrs[key])===observed[key]-frame.before[key]);
  }
 });
 return a.result();
}

function go(source,maxBytes) {
 const a=accumulator(maxBytes),packages=new Map(),running=new Set();let events=0;
 for(const line of source.split('\n')){
  if(!line.trim())continue;requireValue(++events<=100000);
  const e=JSON.parse(line);requireValue(e&&typeof e.Package==='string'&&e.Package.length>0&&typeof e.Action==='string');
  if(e.Test!==undefined)requireValue(typeof e.Test==='string');
  const pkg=packages.get(e.Package),key=JSON.stringify([e.Package,e.Test]);
  if(e.Action==='start'){requireValue(!pkg);packages.set(e.Package,{closed:false,running:0});a.counts.suites++;continue;}
  requireValue(pkg&&!pkg.closed);
  if(e.Action==='run'){requireValue(e.Test&&!running.has(key));running.add(key);pkg.running++;}
  else if(['pause','cont'].includes(e.Action))requireValue(running.has(key));
  else if(['pass','fail','skip'].includes(e.Action)){
   if(e.Test){requireValue(running.delete(key));pkg.running--;a.addTest(e.Action);if(e.Action==='fail')a.add(`FAIL ${e.Package}.${e.Test}`,'See retained test output.',true);}
   else {requireValue(pkg.running===0);pkg.closed=true;if(e.Action==='fail')a.add(`PACKAGE FAIL ${e.Package}`,'Package did not pass.',true);}
  }else if(e.Action==='output'){
   requireValue(typeof e.Output==='string');
   // Only native test-runner progress lines are omitted; arbitrary test output remains diagnostic.
   const text=e.Output.split('\n').filter(l=>l&&!/^(?:=== (?:RUN|PAUSE|CONT)\s+|\s*--- (?:PASS|SKIP):\s+|PASS$|ok\s+\S+\s+[\d.]+s(?:\s+.*)?$)/.test(l)).join('\n');
   if(text)a.add(`OUTPUT ${e.Package}${e.Test?'.'+e.Test:''}`,text);
  }else throw Error('unknown_go_event');
 }
 requireValue(packages.size>0&&!running.size&&[...packages.values()].every(p=>p.closed));
 return a.result();
}

function trx(source,maxBytes) {
 const a=accumulator(maxBytes),outcomes={};let current=null,counters=null;
 const statuses={Passed:'pass',Failed:'fail',Error:'fail',NotRunnable:'fail',NotExecuted:'skip',Timeout:'cancelled',Aborted:'cancelled',Inconclusive:'fail'};
 const metadata=new Set(['Times','TestSettings','Description','Deployment','Execution','TestDefinitions','UnitTest','TestMethod','TestEntries','TestEntry','TestLists','TestList','Properties','Property','Key','Value','Owners','Owner','TestCategory','TestCategoryItem','Workitems','Workitem']);
 const nodes=new Set(['TestRun','Results','UnitTestResult','Output','ErrorInfo','Message','StackTrace','StdOut','StdErr','DebugTrace','TextMessages','Text','ResultSummary','Counters','RunInfos','RunInfo','Exception',...metadata]);
 const parents={TestRun:[],Results:['TestRun'],UnitTestResult:['Results'],Output:['UnitTestResult','ResultSummary'],
  ErrorInfo:['Output'],Message:['ErrorInfo'],StackTrace:['ErrorInfo'],StdOut:['Output'],StdErr:['Output'],DebugTrace:['Output'],
  TextMessages:['Output'],Text:['TextMessages','RunInfo'],Exception:['RunInfo'],ResultSummary:['TestRun'],Counters:['ResultSummary'],RunInfos:['ResultSummary'],RunInfo:['RunInfos']};
 walkXml(source,(f,stack)=>{
  requireValue(nodes.has(f.name));
  if(!stack.length)requireValue(f.name==='TestRun'&&(!f.attrs.xmlns||f.attrs.xmlns==='http://microsoft.com/schemas/VisualStudio/TeamTest/2010'));
  else if(parents[f.name])requireValue(parents[f.name].includes(stack.at(-1).name));
  if(f.name==='Results'){requireValue(stack.at(-1)?.name==='TestRun');a.counts.suites++;}
  if(f.name==='UnitTestResult'){
   requireValue(stack.at(-1)?.name==='Results'&&!current&&f.attrs.testName?.trim()&&Object.hasOwn(statuses,f.attrs.outcome));
   current={name:f.attrs.testName,outcome:f.attrs.outcome};
  }
  if(f.name==='Counters'){requireValue(!counters&&stack.at(-1)?.name==='ResultSummary');counters=f.attrs;}
 },(f,stack)=>{
  if(['TestRun','Results','ResultSummary','Counters','RunInfos'].includes(f.name))requireValue(!f.ownText);
  if(f.name==='UnitTestResult'){
   a.addTest(statuses[current.outcome]);outcomes[current.outcome]=(outcomes[current.outcome]??0)+1;
   if(current.outcome!=='Passed')a.add(`${current.outcome.toUpperCase()} ${current.name}`,f.text,true,f.clipped);
   else if(f.text.trim())a.add(`OUTPUT ${current.name}`,f.text,false,f.clipped);
   current=null;
  }else if(f.name==='Output'&&stack.at(-1)?.name==='ResultSummary'&&f.text.trim())a.add('RUN OUTPUT',f.text,false,f.clipped);
  else if(f.name==='RunInfo'&&f.text.trim())a.add(`RUN ${f.attrs.outcome??'INFO'}`,f.text,false,f.clipped);
  else if(f.name==='ResultSummary'&&f.attrs.outcome&&f.attrs.outcome!=='Passed')a.add(`RUN ${f.attrs.outcome}`,'See report result summary.',true);
 });
 requireValue(counters&&natural(counters.total)===a.counts.tests);
 for(const name of Object.keys(statuses)){
  const key=name[0].toLowerCase()+name.slice(1);
  // VSTest can leave notExecuted=0 for skipped result rows. Reconcile that
  // native variant only when the independent executed/total counts agree.
  if(name==='NotExecuted'&&counters[key]==='0'&&(outcomes[name]??0)>0
    &&natural(counters.executed)===a.counts.tests-outcomes[name])continue;
  if(counters[key]!==undefined)requireValue(natural(counters[key])===(outcomes[name]??0));
 }
 return a.result();
}

export function parseTestReport(format,source,maxBytes) {
 try{
  requireValue(typeof source==='string'&&Buffer.byteLength(source)<=MAX_BYTES&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source));
  if(format==='go-test-json')return go(source,maxBytes);
  const xml=source.replace(/^\uFEFF/,'');
  if(format==='junit-xml')return junit(xml,maxBytes);
  if(format==='trx-xml')return trx(xml,maxBytes);
 }catch{return null;}
 return null;
}
