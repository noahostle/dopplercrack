import test from "node:test";import assert from "node:assert/strict";
import{randomUUID}from"node:crypto";import{mkdir,writeFile,rm}from"node:fs/promises";import{existsSync}from"node:fs";import{join,resolve,sep}from"node:path";
import{startDopplerApp}from"./app.mjs";import{projectRoot}from"./config.mjs";import{embeddingOrigin}from"../lib/bridge.mjs";

test("Standalone application serves its UI and API without exposing the private runner token",async()=>{
  const app=await startDopplerApp({port:0,mapsKey:"browser-test-key"});
  try{
    const health=await(await fetch(app.url+"/health")).json();assert.equal(health.application,"dopplercrack");assert.equal(typeof health.available,"boolean");assert.ok(!JSON.stringify(health).includes(app.secret));
    const api=await(await fetch(app.url+"/api/doppler")).json();assert.equal(api.mapsKey,"browser-test-key");assert.ok(!JSON.stringify(api).includes(app.secret));
    assert.equal((await fetch(app.endpoint+"/health")).status,401);
    const page=await fetch(app.url+"/doppler?job=example");assert.equal(page.status,existsSync(join(projectRoot,"dist/index.html"))?200:503);
    if(page.ok){assert.match(await page.text(),/<title>Dopplercrack/);const countries=await(await fetch(app.url+"/doppler/world.json")).json();assert.ok(countries.length>240);}
    assert.equal((await fetch(app.url+"/api/doppler?job=bad")).status,400);
    assert.equal((await fetch(app.url+"/api/doppler?action=cancel&job="+randomUUID(),{method:"POST",headers:{Origin:"https://example.invalid"}})).status,403);
    assert.equal((await fetch(app.url+"/api/doppler?action=unknown",{method:"POST"})).status,400);
    assert.equal((await fetch(app.url+"/runtime/jobs/private.json")).status,existsSync(join(projectRoot,"dist/index.html"))?404:503);
  }finally{await app.close();}
});
test("Previously saved analyses are never restored into a fresh recording session",async()=>{
  const app=await startDopplerApp({port:0}),id=randomUUID(),jobsRoot=resolve(projectRoot,"runtime/jobs"),folder=resolve(jobsRoot,id),bytes=Buffer.from(Array.from({length:64},(_,i)=>i));
  assert.ok(folder.startsWith(jobsRoot+sep));await mkdir(folder,{recursive:true});
  try{
    await writeFile(join(folder,"job.json"),JSON.stringify({id,state:"ready",name:"Range fixture",spectrumReady:true}));await writeFile(join(folder,"spectrum.bin"),bytes);
    const response=await fetch(`${app.url}/api/doppler?job=${id}`);assert.equal(response.status,410);assert.match((await response.json()).error,/fresh analysis/);
    assert.equal((await fetch(`${app.url}/api/doppler?job=${id}&action=spectrum`,{headers:{Range:"bytes=8-15"}})).status,410);
  }finally{await app.close();await rm(folder,{recursive:true,force:true});}
});
test("Optional integration accepts only explicit loopback parent origins",()=>{
  assert.equal(embeddingOrigin("?embedded=1&parentOrigin=http://127.0.0.1:5173"),"http://127.0.0.1:5173");assert.equal(embeddingOrigin("?embedded=1&parentOrigin=http://localhost:5173"),"http://localhost:5173");
  for(const value of["?parentOrigin=http://localhost:5173","?embedded=1&parentOrigin=https://example.com","?embedded=1&parentOrigin=javascript:alert(1)","?embedded=1&parentOrigin=http://localhost.example.com"])assert.equal(embeddingOrigin(value),undefined);
});
