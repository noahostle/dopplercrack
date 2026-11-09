import test from "node:test";
import assert from "node:assert/strict";
import {reviewedMeasurements,candidateGridBatches,refinedGrid,polishGrid,flightLeaders} from "./doppler-method.mjs";
import {aircraftDescription,isKnownJet,countries,loadTracks,validateSearch,insideCountry,countryRow} from "./doppler-data.mjs";
import {geoidHeight,hgtHeight,terrainTile} from "./doppler-terrain.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const event={id:1,start:0,end:30,points:[[0,120,1],[30,80,1]]};
const measurement={id:1,cpaSeconds:15,cpaTolerance:5,minSpeed:60,maxSpeed:180,minSlant:100,maxSlant:8000,minRestHz:95,maxRestHz:105,reviewed:true};
test("Unreviewed proposals, including forced paths through noise, cannot become accepted aircraft measurements",()=>{
  assert.throws(()=>reviewedMeasurements([event],{},36),/Review event/);
  assert.throws(()=>reviewedMeasurements([event],{eventMeasurements:[{...measurement,reviewed:false}]},36),/Review event/);
  assert.throws(()=>reviewedMeasurements([event],{eventMeasurements:[{...measurement,reviewed:"false"}]},36),/Review event/);
  assert.equal(reviewedMeasurements([event],{eventMeasurements:[measurement]},36).length,1);
  assert.throws(()=>reviewedMeasurements([event],{eventMeasurements:[{...measurement,minSlant:9000,maxSlant:8000}]},36),/invalid measurement/);
});
test("Known jets are excluded while missing/unknown type codes remain eligible",async()=>{
  const lookup={A320:{desc:"L2J"},DH8D:{desc:"L2T"}};
  assert.equal(aircraftDescription("A320","",lookup),"L2J");assert.equal(aircraftDescription("DH8D","",lookup),"L2T");assert.equal(aircraftDescription("ZZZZ","",lookup),"");
  assert.ok(isKnownJet(["a",0,0,0,0,"L2J"]));assert.ok(!isKnownJet(["a",0,0,0,0,"L2T"]));assert.ok(!isKnownJet(["a",0,0,0,0]));
  const root=await mkdtemp(join(tmpdir(),"doppler-types-")),base=1767225600;
  try{const csv="icao,timestamp,lat,lon,altitude_m,icao_description\n"+["jet","prop","unknown"].flatMap((id,k)=>Array.from({length:8},(_,i)=>[id,base+i,-33.86,151.2,2000,["L2J","L2T",""][k]].join(","))).join("\n");
    const settings=validateSearch({countries:["AU"],startUtc:"2026-01-01T00:00:00Z",endUtc:"2026-01-01T00:01:00Z"},36);const rows=await loadTracks(settings,csv,undefined,undefined,{root,index:new Map()});assert.deepEqual([...new Set(rows.map(r=>r[0]))],["prop","unknown"]);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Corridor chunks preserve 200 m spacing and expand every survivor to 100 m, independently of rank",async()=>{
  const base=1767225600,au=countries.find(c=>c.code==="AU"),settings={selected:[au],start:base,end:base+60,soundSpeed:343,altitude:0,bounds:{west:151.19,east:151.21,south:-33.87,north:-33.85}};
  const rows=Array.from({length:21},(_,i)=>["prop",base-20+i*2,-33.86,151.18+i*.002,2000]);
  const chunks=[];for await(const chunk of candidateGridBatches(rows,settings,measurement,{batchSize:7}))chunks.push(chunk);
  assert.ok(chunks.length>1);assert.ok(chunks.every(c=>c.length<=7));const cells=chunks.flat();assert.equal(new Set(cells.map(c=>`${c[0]}:${c[1]}`)).size,cells.length);
  const survivors=[{lat:-33.86,lon:151.2,loss:0},{lat:-33.855,lon:151.205,loss:1000}],fine=refinedGrid(survivors,settings);
  assert.ok(survivors.every(c=>fine.some(p=>Math.hypot((p[0]-c.lat)*111,(p[1]-c.lon)*92)<.1)),"Even the low-ranked survivor must be refined");
  const polished=polishGrid(survivors[0],settings);assert.ok(polished.length>500);assert.ok(polished.every(p=>Math.hypot((p[0]-survivors[0].lat)*111320,(p[1]-survivors[0].lon)*111320*Math.cos(p[0]*Math.PI/180))<=500.001));
});
test("Flight comparisons group by aircraft tuple using the actual scoring order",()=>{
  const leaders=flightLeaders([{flights:["a"],loss:.01,rankLoss:-3},{flights:["a"],loss:.001,rankLoss:-2},{flights:["b"],loss:.02,rankLoss:-4}]);assert.deepEqual(leaders.map(c=>c.flights[0]),["b","a"]);assert.equal(leaders[1].rankLoss,-3);
});
test("Scan-line polygon classification agrees at random points, vertices, holes and exact ray intersections",()=>{
  const hole={polygons:[[[[0,0],[2,0],[2,2],[0,2],[0,0]],[[.5,.5],[1.5,.5],[1.5,1.5],[.5,1.5],[.5,.5]]]],boxes:[[0,0,2,2]]};
  let seed=8751;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const country of [...countries,hole])for(let i=0;i<10;i++){
    const box=country.boxes?.[0]||[-180,-90,180,90],lat=box[1]+random()*(box[3]-box[1]),row=countryRow(lat,country);
    for(let j=0;j<30;j++){const lon=box[0]+random()*(box[2]-box[0]);assert.equal(row(lon),insideCountry(lon,lat,country));}
    for(const polygon of country.polygons.slice(0,2))for(const ring of polygon)for(let k=0,j=ring.length-1;k<ring.length;j=k++){
      const [xi,yi]=ring[k],[xj,yj]=ring[j];if((yi>lat)!==(yj>lat)){const x=(xj-xi)*(lat-yi)/(yj-yi)+xi;assert.equal(row(x),insideCountry(x,lat,country));}
    }
  }
  for(const polygon of hole.polygons)for(const ring of polygon)for(const [lon,lat]of ring)assert.equal(countryRow(lat,hole)(lon),insideCountry(lon,lat,hole));
});
test("Conservative corridor bins preserve the entire reference grid and chunk order, including wrap and polar rows",async()=>{
  const world={code:"XX",polygons:[],center:[0,0]};
  for(const [lat,lon]of[[-33.86,151.2],[0,179.999],[89.8,20],[-89.8,-30]]){
    const centerLon=lon,polygons=[[[[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]]]],country={...world,polygons,boxes:[[-180,-90,180,90]]};
    const halfWidth=Math.abs(lat)>80?.08:.008;
    const settings={selected:[country],start:1767225600,end:1767225660,soundSpeed:343,altitude:0,bounds:{south:lat-.008,north:lat+.008,west:centerLon-halfWidth,east:centerLon+halfWidth}};
    if(lon>179.99)settings.bounds.east=-179.99;
    const rows=Array.from({length:21},(_,i)=>["prop",settings.start-20+i*2,lat,((lon+(i-10)*.001/Math.max(.025,Math.cos(lat*Math.PI/180))+540)%360)-180,2000]);
    const grids=[];for(const reference of[true,false]){const chunks=[];for await(const chunk of candidateGridBatches(rows,settings,{...measurement,minSpeed:10,maxSpeed:245,maxSlant:1000},{reference,batchSize:13}))chunks.push(chunk);grids.push(chunks);}
    assert.ok(grids[0].length);assert.deepEqual(grids[1],grids[0]);
  }
});
test("DEM and geoid interpolation preserve negative coordinates, metres, vertical-datum sign and longitude wrap",()=>{
  assert.deepEqual(terrainTile(-33.86,151.2),{south:-34,west:151,name:"S34E151"});
  const hgt=Buffer.alloc(1201*1201*2);for(let i=0;i<hgt.length;i+=2)hgt.writeInt16BE(100,i);
  assert.equal(hgtHeight(hgt,-33.5,151.5,terrainTile(-33.5,151.5)),100);
  const gtx=Buffer.alloc(40+3*4*4);gtx.writeDoubleBE(-90,0);gtx.writeDoubleBE(-180,8);gtx.writeDoubleBE(90,16);gtx.writeDoubleBE(90,24);gtx.writeInt32BE(3,32);gtx.writeInt32BE(4,36);for(let i=40;i<gtx.length;i+=4)gtx.writeFloatBE(25,i);
  assert.equal(geoidHeight(gtx,-33.5,151.5),25);assert.equal(geoidHeight(gtx,0,180),geoidHeight(gtx,0,-180));
  assert.equal(hgtHeight(hgt,-33.5,151.5,terrainTile(-33.5,151.5))+geoidHeight(gtx,-33.5,151.5),125,"Ellipsoidal h = orthometric H + geoid N");
  hgt.writeInt16BE(-32768,(600*1201+600)*2);assert.throws(()=>hgtHeight(hgt,-33.5,151.5,terrainTile(-33.5,151.5)),/DEM void/);
});
