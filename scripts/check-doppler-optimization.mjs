// Reproducible, paired exhaustive/bounded checks. Never calls an AI endpoint.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdir,readFile,writeFile,open} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {nativeSession} from "../server/doppler-native.mjs";
import {linuxPath,mergeCandidates} from "../server/doppler-runner.mjs";
import {flightLeaders} from "../server/doppler-method.mjs";

const root=fileURLToPath(new URL("../",import.meta.url)),dir=join(root,"runtime/performance"),fixtures=join(dir,"fixtures");await mkdir(dir,{recursive:true});
const binaries={reference:join(dir,"reference"),bounded:join(dir,"bounded"),audit:join(dir,"bounds-test")},windows=process.platform==="win32";
function run(command,args,env){
  const begin=performance.now(),result=spawnSync(windows?"wsl.exe":command,windows?["--exec",command,...args]:args,{cwd:root,encoding:"utf8",windowsHide:true,maxBuffer:2**22,env:env||process.env});
  assert.equal(result.status,0,result.stderr||result.error?.message);return {...result,wallSeconds:(performance.now()-begin)/1000};
}
const flags=["-O3","-std=c11","-Wall","-Wextra","-Werror","-pthread"];
if(process.platform==="darwin")flags.push(process.arch==="arm64"?"-mcpu=apple-m1":"-march=native","-framework","Accelerate");else flags.push("-march=native","-lm");
for(const label of["reference","bounded","audit"]){const source=join(root,`native/${label==="audit"?"bounds-test":"worker"}.c`);run("cc",[linuxPath(source),...flags,...(label==="reference"?["-DDOPPLER_REFERENCE"]:[]),"-o",linuxPath(binaries[label])]);}
const fixtureRun=spawnSync(process.execPath,[join(root,"scripts/check-doppler.mjs")],{cwd:root,encoding:"utf8",windowsHide:true,env:{...process.env,DOPPLER_TEST_DIR:fixtures,DOPPLER_TEST_BINARY:binaries.bounded},maxBuffer:2**22});assert.equal(fixtureRun.status,0,fixtureRun.stderr);process.stdout.write(fixtureRun.stdout);
const base=1767225600,report={createdAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,flags,cases:[]};
await writeFile(join(fixtures,"single-ridges.csv"),(await readFile(join(fixtures,"ridges.csv"),"utf8")).split("\n").filter(line=>line.startsWith("1,")).join("\n"));
await writeFile(join(fixtures,"single-reviewed.csv"),"1,44.79994,60,100,120,50,10000,105,165\n");
const caseList=[
  {name:"two-events",cells:"cells.csv"},
  {name:"spectrum",spectral:1},
  {name:"shared-clock",ridges:"offset-ridges.csv",measurements:"offset-reviewed.csv"},
  {name:"broad-wrong-shape",ridges:"offset-ridges.csv",measurements:"broad-offset-reviewed.csv"},
  {name:"gap",tracks:"gap-tracks.csv"},
  {name:"jet",tracks:"jet-tracks.csv"},
  {name:"silence",tracks:"extra-tracks.csv",silence:1},
  {name:"losing-tuple",tracks:"duplicate-tracks.csv"},
  {name:"turning",tracks:"turning-tracks.csv",ridges:"turning-ridges.csv",measurements:"turning-reviewed.csv",cells:"cells.csv"},
  {name:"wide-clock-single",ridges:"single-ridges.csv",measurements:"single-reviewed.csv",cells:"cells.csv",start:base-3600,end:base+3600,step:.25},
  {name:"fixed-clock-single",ridges:"single-ridges.csv",measurements:"single-reviewed.csv",cells:"cells.csv",start:base,end:base},
];
async function locate(label,c,incumbents="-"){
  const output=join(dir,`${c.name}-${label}.json`),args=["locate",...([c.ridges||"ridges.csv",c.tracks||"tracks.csv",c.cells||"truth-cell.csv",c.measurements||"reviewed.csv","spectrum.bin"].map(name=>linuxPath(join(fixtures,name)))),String(c.start??base-2),String(c.end??base+2),String(c.step||1),String(c.threads||1),"343",linuxPath(output),String(c.filter||0),String(c.spectral||0),String(c.silence||0),incumbents];
  const timing=run(linuxPath(binaries[label]),args),result=JSON.parse(await readFile(output,"utf8"));return {result,wallSeconds:timing.wallSeconds};
}
for(const c of caseList){
  const ref=await locate("reference",c),fast=await locate("bounded",c);for(const key of["candidates","flightLeaders","cellsEvaluated"])assert.deepEqual(fast.result[key],ref.result[key],`${c.name}: ${key}`);
  if(c.name==="wide-clock-single")assert.deepEqual((await locate("bounded",{...c,threads:4})).result.candidates,ref.result.candidates,"One/four-thread bounded rankings");
  const entry={name:c.name,identicalRanking:true,referenceSeconds:ref.result.elapsedSeconds,boundedSeconds:fast.result.elapsedSeconds,bounds:fast.result.bounds};report.cases.push(entry);console.log(JSON.stringify(entry));
}
// Repeat score/filter/score on one process to catch stale cells, counters,
// frequency data, thread leaders and filter-to-spectral transitions.
const session=nativeSession({binary:linuxPath(binaries.bounded),args:["ridges.csv","tracks.csv","reviewed.csv","spectrum.bin"].map(name=>linuxPath(join(fixtures,name))).concat(["1","343","1","0"])});
await writeFile(join(fixtures,"session cells é.csv"),await readFile(join(fixtures,"truth-cell.csv")));
try{for(const filter of[true,false,true,false]){
  const output=join(dir,"session output é.json");await session.request({cells:linuxPath(join(fixtures,"session cells é.csv")),output:linuxPath(output),start:base-2,end:base+2,step:1,filter});
  const actual=JSON.parse(await readFile(output,"utf8")),expected=(await locate("reference",{name:"session-control",spectral:1,filter:filter?1:0})).result;
  assert.deepEqual(actual.candidates,expected.candidates);assert.deepEqual(actual.flightLeaders,expected.flightLeaders);
}}finally{await session.close();}
// A deliberately oversized request must terminate the actual native process
// when its deadline expires, rather than leaving a WSL calculation running.
await writeFile(join(fixtures,"timeout-cells.csv"),((await readFile(join(fixtures,"cells.csv"),"utf8")).trim()+"\n").repeat(400));
let resolveExit;const exited=new Promise(resolve=>{resolveExit=resolve;});
const deadlineSession=nativeSession({binary:linuxPath(binaries.bounded),args:["ridges.csv","tracks.csv","reviewed.csv","spectrum.bin"].map(name=>linuxPath(join(fixtures,name))).concat(["1","343","0","0"]),onChild:child=>child.once("close",resolveExit)});
try{await assert.rejects(deadlineSession.request({cells:linuxPath(join(fixtures,"timeout-cells.csv")),output:linuxPath(join(dir,"timeout.json")),start:base-2,end:base+2,step:1,timeoutMs:1}),/timed out/);
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Timed-out worker did not exit")),5000);})]);}finally{clearTimeout(timer);}
}finally{await deadlineSession.close();}
// Global incumbents must preserve the merged ranking across chunk boundaries.
const incumbentCase=caseList.find(c=>c.name==="wide-clock-single"),seed=(await locate("reference",incumbentCase)).result,incumbents=join(dir,"incumbents.csv");
await writeFile(incumbents,seed.flightLeaders.map(c=>`flight,${c.flights[0]},${c.rankLoss}`).join("\n"));
const improvement=(await locate("bounded",incumbentCase,linuxPath(incumbents))).result;
assert.deepEqual(mergeCandidates(seed.candidates,improvement.candidates),mergeCandidates(seed.candidates));assert.deepEqual(flightLeaders([...seed.flightLeaders,...improvement.flightLeaders]),seed.flightLeaders);
for(const turning of[false,true]){
 const args=[turning?"turning-ridges.csv":"single-ridges.csv",turning?"turning-tracks.csv":"tracks.csv","cells.csv",turning?"turning-reviewed.csv":"single-reviewed.csv"].map(name=>linuxPath(join(fixtures,name)));
 const audit=JSON.parse(run(linuxPath(binaries.audit),[...args,String(base)]).stdout);report.cases.push({name:turning?"turning-bound-audit":"bound-audit",...audit});console.log(JSON.stringify(audit));
}
if(process.argv.includes("--day")){
 const path=join(fixtures,"day-tracks.csv"),file=await open(path,"w");let lines=[];
 try{for(let plane=0;plane<16;plane++)for(let t=-43200;t<=43200;t++){
   const lon=((151.2+(t-38-plane*1800)*110/(111320*Math.cos(-33.86*Math.PI/180))+540)%360)-180;lines.push([`DAY${plane}`,base+t,-33.86,lon.toFixed(8),2000].join(","));
   if(lines.length===10000){await file.write(lines.join("\n")+"\n");lines=[];}
 }if(lines.length)await file.write(lines.join("\n")+"\n");}finally{await file.close();}
 await writeFile(join(fixtures,"day-cells.csv"),Array.from({length:1000},(_,i)=>[-33.86+Math.floor(i/40)*.0001,151.2+(i%40)*.0001,0].join(",")).join("\n"));
 const c={name:"day-physics",ridges:"single-ridges.csv",measurements:"single-reviewed.csv",tracks:"day-tracks.csv",cells:"day-cells.csv",filter:1,start:base-60,end:base+60};
 const ref=await locate("reference",c),fast=await locate("bounded",c);assert.deepEqual(fast.result.candidates,ref.result.candidates);
 const entry={name:c.name,rows:16*86401,cells:1000,identicalRanking:true,referenceSeconds:ref.result.elapsedSeconds,boundedSeconds:fast.result.elapsedSeconds,kernelSpeedup:ref.result.elapsedSeconds/fast.result.elapsedSeconds,referenceWallSeconds:ref.wallSeconds,boundedWallSeconds:fast.wallSeconds};report.cases.push(entry);console.log(JSON.stringify(entry));
}
await writeFile(join(dir,`report-${report.createdAt.replace(/[:.]/g,"-")}.json`),JSON.stringify(report,null,2));
await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));console.log(`Paired comparisons, interval audits, thread parity and native session reuse passed. Report: ${join(dir,"report.json")}`);
