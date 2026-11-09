import test from "node:test";import assert from "node:assert/strict";
import {mkdtemp,rm,stat,readFile,writeFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";import {join,resolve,dirname} from "node:path";
import {Readable} from "node:stream";import {createServer} from "node:http";import {once} from "node:events";
import {saveUpload} from "./doppler-upload.mjs";import {handleDopplerApi} from "./api.mjs";import {withTemporaryDownload} from "./doppler-media.mjs";

test("The public upload proxy streams files above the old 256 MB cap to disk",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-upload-test-")),path=join(root,"large.bin"),bytes=257*2**20;
  const server=createServer(async(req,res)=>{try{const uploaded=await saveUpload(req,path);res.writeHead(202,{"Content-Type":"application/json"});res.end(JSON.stringify(uploaded));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});server.requestTimeout=0;server.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const chunk=new Uint8Array(64*1024).fill(23);let sent=0;
    const body=new ReadableStream({pull(controller){if(sent===bytes)return controller.close();controller.enqueue(chunk);sent+=chunk.length;}});
    const request=new Request("http://localhost/api/doppler",{method:"POST",duplex:"half",headers:{"Content-Type":"application/octet-stream","Content-Length":String(bytes),"X-Media-Name":"large.wav"},body});
    const response=await handleDopplerApi(request,{endpoint:`http://127.0.0.1:${server.address().port}`,secret:"test-stream-token"});
    assert.equal(response.status,202);const result=await response.json();assert.equal(result.bytes,bytes);assert.equal((await stat(path)).size,bytes);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test("Aborted uploads remove partials and never replace or remove an existing file",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-upload-test-"));try{
    const path=join(root,"media.bin");
    async function* interrupted(){yield Buffer.alloc(4096);throw Error("client disconnected");}
    await assert.rejects(saveUpload(Readable.from(interrupted()),path),/disconnected/);await assert.rejects(stat(path),{code:"ENOENT"});
    await writeFile(path,"keep");await assert.rejects(saveUpload(Readable.from([Buffer.alloc(256)]),path),{code:"EEXIST"});assert.equal(await readFile(path,"utf8"),"keep");
  }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test("Temporary YouTube downloads are removed on success, failure and cancellation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"doppler-download-test-"));try{
    await writeFile(join(root,"evidence.json"),"keep");
    for(const failure of[false,true]){let path;const task=withTemporaryDownload(root,async folder=>{path=folder;await writeFile(join(folder,"media.webm.part"),"clip");if(failure)throw Error("cancelled");return 42;});if(failure)await assert.rejects(task,/cancelled/);else assert.equal(await task,42);await assert.rejects(stat(path),{code:"ENOENT"});}
    assert.deepEqual(await readdir(root),["evidence.json"]);
  }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
