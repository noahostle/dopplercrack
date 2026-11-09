import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {sessionWorkspace} from './doppler-session.mjs';
import {readinessSteps,recordingStartError} from '../lib/doppler-readiness.mjs';
test('Temporary recording workspaces delete only owned jobs and leave persistent data alone',async()=>{
 const root=await mkdtemp(join(tmpdir(),'doppler-session-'));
 try{
  await writeFile(join(root,'archive.keep'),'keep');const workspace=sessionWorkspace(join(root,'sessions'));await workspace.initialize();
  const id=randomUUID();await mkdir(join(workspace.root,id));await writeFile(join(workspace.root,id,'recording.wav'),'temporary');
  await assert.rejects(workspace.removeJob('../archive.keep'));await workspace.removeJob(id);assert.deepEqual(await readdir(workspace.root),[]);
  await workspace.close();assert.equal(await readFile(join(root,'archive.keep'),'utf8'),'keep');assert.deepEqual(await readdir(join(root,'sessions')),[]);
 }finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('Readiness identifies missing signal and allows one exact start without hidden range fields',()=>{
 const exact={mode:'exact',dateFrom:'2026-10-27',dateTo:'',timeFrom:'09:59:00',timeTo:'',timeZone:'Australia/Sydney',stepSeconds:1};
 assert.equal(recordingStartError(exact),'');assert.match(recordingStartError({...exact,mode:'range'}),/last date/);
 const job={media:{},duration:30,segment:{start:0,end:30},detectorVersion:4,state:'ready',events:[]};
 const steps=readinessSteps(job,['AU'],exact,{available:true});assert.deepEqual(steps.filter(s=>!s.ready).map(s=>s.id),['signal']);assert.match(steps.find(s=>s.id==='signal').detail,/No coherent/);
 assert.ok(readinessSteps({...job,events:[{id:1}]},['AU'],exact,{available:true}).every(s=>s.ready));
 assert.ok(readinessSteps(null,[],{...exact,dateFrom:'',timeFrom:''},null).every(s=>!s.ready));
});
