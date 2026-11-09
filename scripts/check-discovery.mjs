// Independent positive/negative audio controls. These are detector regressions,
// not a claim of accuracy on arbitrary real-world recordings.
import assert from 'node:assert/strict';import{mkdir,readFile,writeFile}from'node:fs/promises';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import{linuxPath}from'../server/doppler-runner.mjs';
const folder=fileURLToPath(new URL('../runtime/discovery-verification/',import.meta.url));await mkdir(folder,{recursive:true});
const binary=linuxPath(process.env.DOPPLER_TEST_BINARY||fileURLToPath(new URL('../runtime/bin/dopplercrack',import.meta.url)));
function run(args){return new Promise((resolve,reject)=>{const p=spawn(process.platform==='win32'?'wsl.exe':binary,process.platform==='win32'?['--exec',binary,...args]:args,{windowsHide:true});let text='';p.stderr.on('data',b=>text+=b);p.on('error',reject);p.on('exit',code=>code?reject(Error(text)):resolve());});}
let seed=0x61734;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32*2-1;}
const harder={short:{duration:8,cp:4,r:1000,f0:160,amp:.12},partial:{duration:30,cp:-12,r:3000,f0:130,amp:.1},weak:{duration:90,cp:45,r:3000,f0:130,amp:.0015},gapped:{duration:90,cp:45,r:2000,f0:130,amp:.06},modulated:{duration:90,cp:45,r:2400,f0:130,amp:.06}};
function wav(kind){const scenario=harder[kind],rate=2048,duration=scenario?.duration||120,n=rate*duration,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);let phase=0,wind=0;
 for(let i=0;i<n;i++){const t=i/rate;wind=.98*wind+.02*random();let value=kind==='silence'?0:random()*.035;
  if(kind==='hum'||kind==='wind')value+=.2*Math.sin(2*Math.PI*100*t)+.08*Math.sin(2*Math.PI*200*t);
  if(kind==='wind')value+=wind*2*(.6+.4*Math.sin(t*.4));
  if(kind==='flyover'||kind==='harmonics'||scenario){
   const v=95,r=scenario?.r||1800,c=343,cp=scenario?.cp??60,f0=scenario?.f0||120,beta=v/c,s=t-cp+r/c,tau=(s-Math.sqrt(beta*beta*s*s+(1-beta*beta)*r*r/c**2))/(1-beta*beta),factor=c/(c+v*v*tau/Math.hypot(r,v*tau));phase+=2*Math.PI*f0*factor*(kind==='modulated'?1+.01*Math.sin(t*.21):1)/rate;
   const amp=scenario?(kind==='gapped'&&t>42&&t<46?0:scenario.amp):.16*Math.sin(Math.PI*t/duration)**2;value+=amp*Math.sin(phase);if(kind==='harmonics')value+=amp*.7*Math.sin(phase*2)+amp*.4*Math.sin(phase*3);
  }
  if(kind==='bursts')value+=random()*.35*(Math.sin(t*1.7)>.5?1:0);
  b.writeInt16LE(Math.round(Math.max(-.99,Math.min(.99,value))*32767),44+i*2);
 }return b;}
const report=[];
for(const kind of['silence','noise','hum','wind','bursts','flyover','harmonics',...Object.keys(harder)]){
 const audio=folder+kind+'.wav',out=folder+kind+'.json';await writeFile(audio,wav(kind));const before=performance.now();await run(['analyze',linuxPath(audio),linuxPath(out)]);const result=JSON.parse(await readFile(out,'utf8'));
 if(harder[kind]){assert.equal(result.events.length,1,kind+' should retain one moving tone');const truth=harder[kind],bounds=result.measurements[0];assert.ok(Math.abs(bounds.cpaSeconds-truth.cp)<=bounds.cpaTolerance,kind+' must not exclude the true CPA');assert.ok(bounds.minRestHz<=truth.f0&&bounds.maxRestHz>=truth.f0,kind+' must not exclude the true rest frequency');}
 else if(['flyover','harmonics'].includes(kind)){assert.equal(result.events.length,1,kind+' should yield exactly one independent event');const fit=result.events[0].approximation;assert.ok(Math.abs(fit.cpaSeconds-60)<5,JSON.stringify(fit));assert.ok(Math.abs(fit.restHz-120)<12||Math.abs(fit.restHz-240)<24||Math.abs(fit.restHz-360)<36,JSON.stringify(fit));}
 else assert.equal(result.events.length,0,kind+' must not create a flyover');
 report.push({kind,events:result.events.length,seconds:(performance.now()-before)/1000,approximations:result.events.map(e=>e.approximation)});console.log(kind+': '+result.events.length+' events');
}
await writeFile(folder+'report.json',JSON.stringify(report,null,2));console.log('Automatic audio controls passed.');
// Two independently generated, known-geometry passes from check-doppler.mjs.
// Use automatic events AND their automatically profiled bounds, not hand labels.
const verification=fileURLToPath(new URL('../runtime/verification/',import.meta.url));
const out=folder+'two-passes.json';await run(['analyze',linuxPath(verification+'acoustic.wav'),linuxPath(out)]);
const auto=JSON.parse(await readFile(out,'utf8'));assert.equal(auto.events.length,2,'Two passes should produce two independent events, not sideband fragments');
assert.ok(Math.abs(auto.events[0].approximation.cpaSeconds-44.8)<5);assert.ok(Math.abs(auto.events[1].approximation.cpaSeconds-173.9)<5);
const keys=['id','cpaSeconds','cpaTolerance','minSpeed','maxSpeed','minSlant','maxSlant','minRestHz','maxRestHz'];
await writeFile(folder+'auto-measurements.csv',auto.measurements.map(m=>keys.map(k=>m[k]).join(',')).join('\n'));
await writeFile(folder+'auto-ridges.csv',auto.events.flatMap(e=>e.points.map(p=>[e.id,...p].join(','))).join('\n'));
await run(['locate',linuxPath(folder+'auto-ridges.csv'),linuxPath(verification+'tracks.csv'),linuxPath(verification+'cells.csv'),linuxPath(folder+'auto-measurements.csv'),linuxPath(out+'.spectrum.bin'),'1767225598','1767225602','1','4','343',linuxPath(folder+'automatic-location.json'),'0','1','1']);
const location=JSON.parse(await readFile(folder+'automatic-location.json','utf8'));assert.ok(location.candidates.length,'Automatic discovery must reach spectral location scoring');
assert.equal(location.candidates[0].lat,-33.86);assert.equal(location.candidates[0].lon,151.2);assert.equal(location.scoreMode,'spectral');
console.log('Automatic two-event discovery → bounds → silence → brightness ranking recovers the synthetic truth cell.');
