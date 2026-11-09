import test from "node:test";import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";import {join,resolve,dirname} from "node:path";
import {archiveInventory,clearArchiveDays} from "./doppler-cache.mjs";
import {once} from "node:events";
import {startDopplerRunner} from "./doppler-runner.mjs";
import {handleDopplerApi} from "./api.mjs";

test("Archive cleanup removes only selected managed days and preserves unrelated files and analyses",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-cache-test-")),cache=join(root,"adsblol");await mkdir(cache);
  try{
    await writeFile(join(cache,"2026-10-01-abcdef.json"),"12345");await writeFile(join(cache,"2026-10-01.complete"),"{}");
    await writeFile(join(cache,"2026-10-02-aabbcc.json"),"123");await writeFile(join(cache,"notes.json"),"keep");await writeFile(join(root,"saved-analysis.json"),"keep");
    const before=await archiveInventory(cache);assert.equal(before.days.length,2);assert.equal(before.bytes,10);assert.equal(before.days[1].complete,true);assert.equal(before.days[0].complete,false);
    for(const dates of[[],["../saved-analysis.json"],["2026-02-30"],["2026-10-01/.."]])await assert.rejects(clearArchiveDays(cache,dates));
    const removed=await clearArchiveDays(cache,["2026-10-01"]);assert.equal(removed.bytes,7);assert.equal(removed.files,2);
    assert.deepEqual((await archiveInventory(cache)).days.map(d=>d.date),["2026-10-02"]);assert.equal(await readFile(join(root,"saved-analysis.json"),"utf8"),"keep");assert.ok((await readdir(cache)).includes("notes.json"));
    assert.equal((await clearArchiveDays(cache,["2026-10-01"])).files,0);
  }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test("Archive cleanup refuses a redirected cache root",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-cache-test-"));try{
    const target=join(root,"real");await mkdir(target);await writeFile(join(target,"2026-10-01-abcdef.json"),"keep");
    await symlink(target,join(root,"redirect"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(clearArchiveDays(join(root,"redirect"),["2026-10-01"]),/real directory/);
    assert.equal(await readFile(join(target,"2026-10-01-abcdef.json"),"utf8"),"keep");
  }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});

test("Archive API authenticates cleanup and rejects cross-origin or invalid dates",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-cache-api-")),secret="archive-cache-test-secret-only";
  const server=startDopplerRunner({port:0,secret,archiveRoot:root});await once(server,"listening");
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  try{
    await writeFile(join(root,"2026-10-01-abcdef.json"),"clear");
    await writeFile(join(root,"2026-10-02-abcdef.json"),"retain");
    assert.equal((await fetch(endpoint+"/cache/clear",{method:"POST",body:'{"dates":["2026-10-01"]}'})).status,401);
    const gateway=(action,origin,dates)=>handleDopplerApi(new Request(`http://localhost:3857/api/doppler?action=${action}`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({dates})}),{endpoint,secret});
    assert.equal((await gateway("clear-cache","https://example.com",["2026-10-01"])).status,403);
    assert.equal((await gateway("clear-cache","http://localhost:3857",["../../unrelated"])).status,400);
    const response=await gateway("clear-cache","http://localhost:3857",["2026-10-01"]);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.cleared.files,1);assert.equal(result.cleared.bytes,5);assert.equal(result.busy,false);
    assert.deepEqual(result.days.map(d=>d.date),["2026-10-02"]);
    assert.equal(await readFile(join(root,"2026-10-02-abcdef.json"),"utf8"),"retain");
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
