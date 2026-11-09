// Opt-in real-audio regression from Colsto's published challenge. The detector
// receives no event bounds or frequencies. This does not validate geolocation.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {linuxPath} from "../server/doppler-runner.mjs";
import {onlineClipArgs,withTemporaryDownload} from "../server/doppler-media.mjs";
const root=fileURLToPath(new URL("../runtime/reference-audio/",import.meta.url));await mkdir(root,{recursive:true});
const binary=process.env.DOPPLER_TEST_BINARY||fileURLToPath(new URL("../runtime/bin/dopplercrack",import.meta.url));
async function command(name,args){return new Promise((resolve,reject)=>{const child=spawn(process.platform==="win32"?"wsl.exe":name,process.platform==="win32"?["--exec",name,...args]:args,{windowsHide:true});let output="";child.stdout.on("data",b=>output=(output+b).slice(-10000));child.stderr.on("data",b=>output=(output+b).slice(-10000));child.once("error",reject);child.once("exit",code=>code?reject(Error(output)):resolve(output));});}
const report=[];
for(const [name,start,end,cp,frequency]of[["pass-one",2095,2215,60.8,112.735],["pass-two",3012,3132,60.36,134.415]]){
  const wav=join(root,`${name}.wav`),out=join(root,`${name}.json`);
  if(!existsSync(wav)){
    if(!process.argv.includes("--download"))throw Error("Reference audio missing; pass --download to fetch two 120-second sections of the public challenge");
    await withTemporaryDownload(root,async folder=>{
      const python=linuxPath(fileURLToPath(new URL("../runtime/python/bin/python",import.meta.url)));
      await command(python,["-m","yt_dlp","--js-runtimes",`node:${linuxPath(process.execPath)}`,...onlineClipArgs("https://www.youtube.com/watch?v=4CxVxuMVkMc",{start,end},linuxPath(join(folder,"media.%(ext)s")))]);
      const file=(await readdir(folder)).find(name=>/^media\.[a-z0-9]{1,8}$/i.test(name));assert.ok(file);
      await command("ffmpeg",["-v","error","-nostdin","-y","-i",linuxPath(join(folder,file)),"-t",String(end-start),"-vn","-ac","1","-ar","2048","-c:a","pcm_s16le",linuxPath(wav)]);
    });
  }
  const before=performance.now();await command(linuxPath(binary),["analyze",linuxPath(wav),linuxPath(out)]);
  const result=JSON.parse(await readFile(out,"utf8"));
  const matching=result.events.filter(e=>Math.abs(e.approximation.cpaSeconds-cp)<20&&[1,2,3].some(h=>Math.abs(e.approximation.restHz/(frequency*h)-1)<.12));
  report.push({name,start,end,seconds:(performance.now()-before)/1000,events:result.events.length,matching:matching.length,approximations:result.events.map(e=>e.approximation)});
  console.log(JSON.stringify(report.at(-1)));await writeFile(join(root,"report.json"),JSON.stringify(report,null,2));
  assert.ok(matching.length,`${name}: should retain the publicly documented moving tone`);
}
