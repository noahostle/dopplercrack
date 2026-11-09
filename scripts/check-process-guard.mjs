import {spawn,spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {linuxPath} from '../server/doppler-runner.mjs';
const windows=process.platform==='win32',guard=linuxPath(fileURLToPath(new URL('./process-guard.py',import.meta.url)));
const child=spawn(windows?'wsl.exe':'python3',[...(windows?['--exec','python3']:[]),guard,'python3','-u','-c','import os,time; print(os.getpid(),flush=True); time.sleep(60)'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let pid;const before=performance.now();child.stdout.on('data',b=>{pid=Number(String(b).trim());child.stdin.end();});
const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
assert.ok(Number.isInteger(pid)&&pid>1);assert.notEqual(code,0);assert.ok(performance.now()-before<15000);
const result=spawnSync(windows?'wsl.exe':'kill',windows?['--exec','kill','-0',String(pid)]:['-0',String(pid)],{windowsHide:true});assert.notEqual(result.status,0,'Cancelled child must not remain running');
console.log('Process lease closes and terminates the media subprocess through WSL/POSIX.');
