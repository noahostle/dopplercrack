import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createTrackStore} from "./doppler-track-store.mjs";
import {loadTracks,validateSearch} from "./doppler-data.mjs";
import {clockBatches} from "./doppler-time.mjs";
const base=1767225600,header="icao,timestamp,lat,lon,altitude_m,icao_description\n";
function trace(icao,t,type="DH8D",lon=151.2){return {icao,t:type,timestamp:t,trace:Array.from({length:20},(_,i)=>[i*5,-33.86,lon+i*.001,5000,0,0,8,0,{},null,5000])};}
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),"doppler-index-")),folder=await mkdtemp(join(tmpdir(),"doppler-index-private-"));
  try{await mkdir(join(root,"adsblol"));await run(root,folder);}finally{await rm(root,{recursive:true,force:true});await rm(folder,{recursive:true,force:true});}
}
test("Disk time index exactly matches reference batches across a day, including duplicate precedence and jet metadata",async()=>fixture(async(root,folder)=>{
  const rows=[];for(let hour=0;hour<24;hour++)for(let i=0;i<30;i++)rows.push([`prop${hour%3}`,base+hour*3600+i*5,-33.86,151.2+i*.001,1500,"L2T"].join(","));
  // Reverse time order to exercise stable source order after the time index.
  await writeFile(join(root,"local.csv"),header+rows.reverse().join("\n"));
  await writeFile(join(root,"a.json"),JSON.stringify(trace("unknown",base,"ZZZZ")));
  await writeFile(join(root,"b.json"),JSON.stringify(trace("jet",base,"A320",0)));
  await writeFile(join(root,"c.json"),JSON.stringify(trace("jet",base,"ZZZZ")));
  await writeFile(join(root,"snapshot.json"),JSON.stringify({now:base,aircraft:Array.from({length:12},(_,i)=>({hex:"emptydesc",alt_geom:5000,lat:-33.86,lon:151.2,seen_pos:-i*5}))}));
  const csv=header+Array.from({length:20},(_,i)=>["unknown",base+i*5,-33.86,151.21,1700,""].join(",")).join("\n");
  const settings=validateSearch({countries:["AU"],startUtc:"2026-01-01T00:00:00Z",endUtc:"2026-01-01T23:59:59Z",timeStep:1},36);
  const store=await createTrackStore(settings,csv,{root,folder,cacheBytes:256});
  try{for(const window of clockBatches(settings,1)){
    const batch={...settings,...window},reference=await loadTracks(batch,csv,undefined,undefined,{root,index:new Map()});
    assert.deepEqual(await store.query(batch),reference);
  }assert.equal(store.stats.sourceReads,5);assert.equal(store.stats.queries,120);
  }finally{await store.close();}
}));
test("Archive day restrictions, incomplete files and a newly completed day preserve reference ordering",async()=>fixture(async(root,folder)=>{
  await writeFile(join(root,"adsblol","2026-01-01-abc123.json"),JSON.stringify(trace("cross",base+86300)));
  await writeFile(join(root,"adsblol","2026-01-01.complete"),"");
  await writeFile(join(root,"adsblol","2026-01-02-abc123.json"),JSON.stringify(trace("cross",base+86400)));
  await writeFile(join(root,"z-local.json"),JSON.stringify(trace("cross",base+86400,"ZZZZ",151.3)));
  const settings=validateSearch({countries:["AU"],startUtc:"2026-01-01T23:58:00Z",endUtc:"2026-01-02T00:02:00Z",allowedArchiveDays:["2026-01-01","2026-01-02"]},36);
  const store=await createTrackStore(settings,undefined,{root,folder});
  try{
    assert.deepEqual(await store.query(settings),await loadTracks(settings,undefined,undefined,undefined,{root,index:new Map()}));
    await writeFile(join(root,"adsblol","2026-01-02.complete"),"");await store.extendArchive("2026-01-02");
    assert.deepEqual(await store.query(settings),await loadTracks(settings,undefined,undefined,undefined,{root,index:new Map()}));
  }finally{await store.close();}
  const restricted={...settings,allowedArchiveDays:["2026-01-01"]},second=await createTrackStore(restricted,undefined,{root,folder});
  try{assert.deepEqual(await second.query(restricted),await loadTracks(restricted,undefined,undefined,undefined,{root,index:new Map()}));}finally{await second.close();}
}));
test("A source snapshot stays fixed across batches and rejects clock windows outside its indexed range",async()=>fixture(async(root,folder)=>{
  const source=join(root,"local.json");await writeFile(source,JSON.stringify(trace("prop",base)));
  const settings=validateSearch({countries:["AU"],startUtc:"2026-01-01T00:00:00Z",endUtc:"2026-01-01T00:02:00Z"},36),store=await createTrackStore(settings,undefined,{root,folder});
  try{const before=await store.query(settings);await writeFile(source,JSON.stringify(trace("different",base)));assert.deepEqual(await store.query(settings),before);await assert.rejects(store.query({...settings,end:settings.end+1}),/outside/);}finally{await store.close();}
}));
