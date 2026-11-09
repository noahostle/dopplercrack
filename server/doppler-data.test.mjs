import test from "node:test";
import assert from "node:assert/strict";
import { countries, insideCountry, inBounds, parseCsv, readsbRows, validateSearch, makeGrid, acquireArchive, loadTracks } from "./doppler-data.mjs";
import { parseRidges } from "./doppler-runner.mjs";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
test("Worldwide selection and regional grid preserve country polygons",()=>{
  assert.ok(countries.length>=249);const au=countries.find(country=>country.code==="AU");assert.ok(insideCountry(151.2,-33.86,au));assert.ok(!insideCountry(0,0,au));
  assert.ok(inBounds(179,0,{west:170,east:-170,south:-5,north:5}));assert.ok(!inBounds(0,0,{west:170,east:-170,south:-5,north:5}));
  const settings={selected:[au],bounds:{west:151.19,east:151.21,south:-33.87,north:-33.85},gridKm:1,altitude:50};
  const grid=makeGrid([["a",1,-33.86,151.2,1000]],settings);assert.ok(grid.length);assert.ok(grid.every(row=>insideCountry(row[1],row[0],au)&&inBounds(row[1],row[0],settings.bounds)));
});
test("Historical imports preserve metre units and geometric altitude, rejecting stale/barometric-only traces",()=>{
  const rows=parseCsv("icao,timestamp,lat,lon,altitude_m\na,2026-01-01T00:00:00Z,-33.8,151.2,2000");assert.equal(rows[0][4],2000);assert.equal(rows[0][1],1767225600);
  const trace={icao:"a12345",timestamp:100,trace:[[1,-33,151,6000,100,90,0,0,null,"adsb_icao",6500],[2,-33,151,6000,100,90,1,0,null,"adsb_icao",6500],[3,-33,151,6000,100,90,0,0]]};
  const parsed=readsbRows(trace);assert.equal(parsed.length,1);assert.equal(parsed[0][1],101);assert.equal(parsed[0][4],6500*.3048);
  assert.throws(()=>parseCsv("icao,timestamp,lat,lon,altitude_ft\na,100,0,0,6500"));
});
test("Long clock windows are batched while ridge measurements require sufficient evidence",()=>{
  const settings=validateSearch({countries:["AU"],startUtc:"2026-01-01T00:00:00Z",endUtc:"2026-01-02T00:00:00Z",timeStep:1},100);
  assert.equal(settings.plan.clockTrials,86401);assert.ok(settings.plan.batchCount>100);
  assert.throws(()=>parseRidges("event,time_seconds,frequency_hz,weight\n1,0,100,1",60));
  const ridges=parseRidges(Array.from({length:12},(_,i)=>`1,${i},${120-i},1`).join("\n"),60);assert.equal(ridges[0].points.length,12);assert.equal(ridges[0].dropHz,11);
});
test("Archive acquisition enforces byte budgets and reads split TAR traces without extracting paths",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"doppler-archive-")),original=globalThis.fetch;
  const trace={icao:"abc123",timestamp:1767225600,trace:[]},compressed=gzipSync(JSON.stringify(trace));
  const header=Buffer.alloc(512);header.write("../../traces/trace_full_abc123.json");header.write(compressed.length.toString(8).padStart(11,"0"),124);header[156]=48;
  const archive=Buffer.concat([header,compressed,Buffer.alloc((512-compressed.length%512)%512),Buffer.alloc(1024)]),parts=[archive.subarray(0,700),archive.subarray(700)];
  let downloaded=0;
  globalThis.fetch=async url=>{
    if(String(url).includes("api.github.com"))return Response.json([{tag_name:"v2026.01.01-planes-readsb-prod-0",html_url:"https://github.com/adsblol/example",assets:parts.map((part,index)=>({name:`archive.tar.a${index?"b":"a"}`,size:part.length,browser_download_url:`https://github.com/adsblol/part${index}`}))}]);
    const index=String(url).endsWith("part1")?1:0;downloaded++;return new Response(parts[index]);
  };
  try{
    await assert.rejects(acquireArchive("2026-01-01",folder,100,()=>{}),/download cap/);assert.equal(downloaded,0);
    await acquireArchive("2026-01-01",folder,10000,()=>{});assert.equal(downloaded,2);assert.deepEqual(JSON.parse(await readFile(join(folder,"2026-01-01-abc123.json"),"utf8")),trace);
    await acquireArchive("2026-01-01",folder,10000,()=>{});assert.equal(downloaded,2,"complete cached day should not download twice");
  }finally{globalThis.fetch=original;await rm(folder,{recursive:true,force:true});}
});
test("Track metadata indexing preserves matches and invalidates edited trace files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-index-")),index=new Map(),base=Date.parse("2026-10-26T20:00:00Z")/1000;
  const trace=(icao,lat,lon)=>({icao,timestamp:base,trace:Array.from({length:10},(_,i)=>[i*2,lat,lon,6500,100,90,0,0,null,"adsb_icao",6500])});
  const settings=validateSearch({countries:["AU"],startUtc:"2026-10-26T20:00:00Z",endUtc:"2026-10-26T20:01:00Z"},36);
  try{
    await writeFile(join(root,"au.json"),JSON.stringify(trace("abc123",-33.86,151.2)));await writeFile(join(root,"us.json"),JSON.stringify(trace("abc124",40,-100)));
    const cold=await loadTracks(settings,undefined,undefined,undefined,{root,index});const warm=await loadTracks(settings,undefined,undefined,undefined,{root,index});
    assert.equal(cold.length,10);assert.deepEqual(warm,cold);assert.equal(index.size,2);
    await writeFile(join(root,"us.json"),JSON.stringify(trace("abc124",-33.85,151.21)));
    const edited=await loadTracks(settings,undefined,undefined,undefined,{root,index});assert.equal(edited.length,20);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Incomplete automatic archives are excluded and explicit UTC-day restrictions apply at midnight",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-day-")),cache=join(root,"adsblol");await mkdir(cache);
  const trace=(icao,timestamp)=>({icao,timestamp,trace:Array.from({length:10},(_,i)=>[i*2,-33.86,151.2,6500,100,90,0,0,null,"adsb_icao",6500])});
  const input={countries:["AU"],startUtc:"2026-10-26T23:59:30Z",endUtc:"2026-10-27T00:00:30Z"};
  try{
    await writeFile(join(cache,"2026-10-26-abc123.json"),JSON.stringify(trace("abc123",Date.parse(input.startUtc)/1000)));await writeFile(join(cache,"2026-10-26.complete"),"{}");
    await writeFile(join(cache,"2026-10-27-abc124.json"),JSON.stringify(trace("abc124",Date.parse("2026-10-27T00:00:00Z")/1000)));
    const before=await loadTracks(validateSearch(input,36),undefined,undefined,undefined,{root});assert.equal(before.length,10);
    await writeFile(join(cache,"2026-10-27.complete"),"{}");
    const full=await loadTracks(validateSearch(input,36),undefined,undefined,undefined,{root});assert.equal(full.length,20);
    const restricted=validateSearch({...input,allowedArchiveDays:["2026-10-26"]},36);
    const day=await loadTracks(restricted,undefined,undefined,undefined,{root});assert.equal(day.length,10);assert.deepEqual(restricted.plan.archiveDays,["2026-10-26"]);
    assert.throws(()=>validateSearch({...input,allowedArchiveDays:["2026-10-25"]},36));
  }finally{await rm(root,{recursive:true,force:true});}
});
