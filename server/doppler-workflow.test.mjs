import test from 'node:test';import assert from 'node:assert/strict';
import{automaticSearchInput,resultLeaderboard}from'./doppler-workflow.mjs';
import{buildClockPlan}from'./doppler-time.mjs';
const now=Date.parse('2026-11-05T12:00:00Z')/1000;
test('Exact recording starts and ranged starts apply the selected clip offset once',()=>{
 const start={mode:'exact',dateFrom:'2026-10-27',dateTo:'',timeFrom:'09:59:00',timeTo:'',timeZone:'Australia/Sydney',stepSeconds:1};
 const exact=buildClockPlan({recordingStart:start,recordingOffsetSeconds:90},60,now);
 assert.equal(exact.mode,'known');assert.equal(exact.clockTrials,1);assert.equal(new Date(exact.start*1000).toISOString(),'2026-10-26T23:00:30.000Z');
 const ranged=buildClockPlan({recordingStart:{...start,mode:'range',dateTo:'2026-10-28',timeFrom:'07:00:00',timeTo:'10:00:00',stepSeconds:5},recordingOffsetSeconds:90},120,now);
 assert.equal(ranged.clockTrials,2*2161);assert.equal(ranged.timeStep,5);assert.ok(ranged.windows.every(w=>w.end-w.start===10800));
 assert.equal(ranged.windows[0].start-Date.parse('2026-10-26T20:00:00Z')/1000,90);
 assert.deepEqual(ranged.windows,buildClockPlan({recordingStart:{...start,mode:'range',dateTo:'2026-10-28',timeFrom:'07:00:00',timeTo:'10:00:00',stepSeconds:5},recordingOffsetSeconds:90},600,now).windows,'Clip length must not shrink or change the candidate start window');
});
test('Automatic browser workflow enforces brightness, terrain, silence and archive acquisition',()=>{
 const job={detectorVersion:4,events:[{id:2}],automaticMeasurements:[{id:2,reviewed:false,source:'automatic-profile-v4'}]};
 const input=automaticSearchInput(job,{countries:['AU'],scoreMode:'trace',silence:false,terrainMode:'constant',tracksCsv:'arbitrary',ridgeCsv:'arbitrary',eventMeasurements:[],timeStep:60});
 assert.equal(input.scoreMode,'spectral');assert.equal(input.silence,true);assert.equal(input.terrainMode,'auto');assert.equal(input.online,true);assert.equal(input.timeStep,1);
 assert.equal(input.tracksCsv,undefined);assert.equal(input.ridgeCsv,undefined);assert.deepEqual(input.eventIds,[2]);assert.deepEqual(input.eventMeasurements,job.automaticMeasurements);
 assert.throws(()=>automaticSearchInput({...job,events:[]},{}),/Insufficient/);assert.throws(()=>automaticSearchInput({...job,detectorVersion:2},{}),/Reanalyze/);
});
test('Daily 7–10 am windows across dates convert separately through Sydney daylight saving',()=>{
 const plan=buildClockPlan({timeRange:{dateFrom:'2026-10-03',dateTo:'2026-10-05',timeFrom:'07:00',timeTo:'10:00',timeZone:'Australia/Sydney'},timeStep:1},30,now);
 assert.equal(plan.windows.length,3);assert.equal(plan.clockTrials,3*10801);
 assert.deepEqual(plan.windows.map(w=>new Date(w.start*1000).toISOString()),['2026-10-02T21:00:00.000Z','2026-10-03T20:00:00.000Z','2026-10-04T20:00:00.000Z']);
 assert.ok(plan.windows.every(w=>w.end-w.start===10800));
});
test('DST repeated hours preserve both instants; skipped local hours are not invented',()=>{
 const range={dateFrom:'2026-04-05',dateTo:'2026-04-05',timeFrom:'02:20',timeTo:'02:30',timeZone:'Australia/Sydney'};
 const fold=buildClockPlan({timeRange:range,timeStep:1},30,now);assert.equal(fold.windows.length,2);assert.equal(fold.clockTrials,1202);assert.equal(fold.windows[1].start-fold.windows[0].start,3600);
 assert.throws(()=>buildClockPlan({timeRange:{...range,dateFrom:'2026-10-04',dateTo:'2026-10-04'},timeStep:1},30,now),/does not occur/);
 assert.throws(()=>buildClockPlan({timeRange:{...range,timeZone:'Invalid/Zone'}},30,now),/timezone/);
});
test('Leaderboard retains the strongest ten distinct flight/day explanations',()=>{
 const rows=Array.from({length:30},(_,i)=>({lat:i,lon:i,clock:100,flights:['FLIGHT'+i],rankLoss:-30+i,score:30-i}));
 const duplicate={...rows[0],score:1,rankLoss:-1};const nextDay={...rows[0],clock:86500,score:29.5,rankLoss:-29.5};
 const result=resultLeaderboard({candidates:[duplicate,...rows],flightLeaders:[nextDay]});assert.equal(result.length,10);assert.deepEqual(result.slice(0,2),[rows[0],nextDay]);
});
