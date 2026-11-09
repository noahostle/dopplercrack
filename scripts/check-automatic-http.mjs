// Exercises public intake: no manual event selection, no curve approvals and
// no AI endpoint. Network acquisition is not needed for these media controls.
import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';
import{startDopplerApp}from'../server/app.mjs';
const app=await startDopplerApp({port:0});
try{
 async function upload(relative){const file=new URL(relative,import.meta.url),body=await readFile(file),r=await fetch(app.url+'/api/doppler',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Media-Name':encodeURIComponent(fileURLToPath(file).split(/[\\/]/).at(-1))},body});assert.equal(r.status,202);let job=await r.json();const id=job.id;const stages=[];for(let i=0;i<240;i++){await new Promise(r=>setTimeout(r,500));job=await(await fetch(app.url+'/api/doppler?job='+id)).json();stages.push(job.state);if(!['inspecting','analyzing'].includes(job.state))break;}assert.equal(job.state,'ready',JSON.stringify(job));assert.ok(!stages.includes('selecting'));assert.equal(job.detectorVersion,4);return job;}
 const speech=await upload('../runtime/whisper/samples/jfk.wav');assert.equal(speech.language.code,'en');console.log('Automatic upload: English language detected without a manual analysis step.');
 const audio=await upload('../runtime/verification/synthetic.wav');assert.equal(audio.events.length,2);assert.ok(audio.automaticMeasurements.every(m=>m.source==='automatic-profile-v4'&&!m.reviewed));
 const input={countries:['AU'],timeRange:{dateFrom:'2026-01-01',dateTo:'2026-01-03',timeFrom:'07:00',timeTo:'10:00',timeZone:'Australia/Sydney'}};
 let response=await fetch(`${app.url}/api/doppler?job=${audio.id}&action=estimate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,202);let result;
 for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));result=await(await fetch(`${app.url}/api/doppler?job=${audio.id}`)).json();if(result.estimate)break;}
 assert.equal(result.estimate.plan.clockTrials,3*10801);assert.equal(result.reviewedSettings.scoreMode,'spectral');assert.equal(result.reviewedSettings.silence,true);assert.equal(result.reviewedSettings.terrainMode,'auto');
 console.log('Public workflow: automatic events, automatic bounds, brightness only, silence always on, and daily hours across dates passed.');
 const noise=await upload('../runtime/discovery-verification/noise.wav');assert.equal(noise.events.length,0);
 response=await fetch(`${app.url}/api/doppler?job=${noise.id}&action=search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,eventMeasurements:audio.automaticMeasurements,ridgeCsv:'1,0,100,1'})});assert.equal(response.status,400);assert.match((await response.json()).error,/Insufficient/);
 console.log('Noise cannot start a location search or bypass automatic checks with injected manual ridges.');
 response=await fetch(`${app.url}/api/doppler?job=${noise.id}&action=discard`,{method:'POST'});assert.equal(response.status,200);
 assert.equal((await fetch(`${app.url}/api/doppler?job=${noise.id}`)).status,410);
 console.log('Discarded recording sessions cannot be restored or reused.');
}finally{await app.close();}
