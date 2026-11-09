import {spawn} from "node:child_process";

// A sequential, framed native session. Dataset lifetime is one unchanged clock
// batch, preserving the reference's track filtering and grid/refinement order.
export function nativeSession({binary,args,signal,onChild=()=>{},timeout=900000}){
  const windows=process.platform==="win32",child=spawn(windows?"wsl.exe":binary,windows?["--exec",binary,"serve",...args]:["serve",...args],{stdio:["pipe","pipe","pipe"],windowsHide:true});
  onChild(child);let pending,pid,sequence=0,closed=false,stdout="",stderr="",progressLines="",resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
  const ended=new Promise(resolve=>child.once("close",resolve));
  function fail(error){rejectReady(error);if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}}
  function stop(error=new Error("Native session stopped")){
    if(closed)return;closed=true;fail(error);
    if(windows&&Number.isSafeInteger(pid)&&pid>1){const killer=spawn("wsl.exe",["--exec","kill","-TERM",String(pid)],{stdio:"ignore",windowsHide:true});killer.on("error",()=>{});}
    child.stdin.destroy();child.kill();
  }
  const aborted=()=>stop(new Error("Job cancelled"));signal?.addEventListener("abort",aborted,{once:true});
  const startup=setTimeout(()=>stop(new Error("Native worker did not start")),30000);
  child.once("error",error=>{clearTimeout(startup);fail(error);});
  child.once("close",code=>{clearTimeout(startup);signal?.removeEventListener("abort",aborted);if(!closed||pending)fail(new Error(`Native session exited (${code}): ${stderr.slice(-1200)}`));closed=true;});
  child.stdin.on("error",error=>fail(error));
  child.stdout.on("data",data=>{
    stdout+=data.toString();if(stdout.length>65536){stop(new Error("Malformed native worker response"));return;}
    const lines=stdout.split("\n");stdout=lines.pop();
    for(const line of lines){let value;try{value=JSON.parse(line);}catch{stop(new Error("Malformed native worker response"));return;}
      if(value.ready){pid=value.pid;clearTimeout(startup);resolveReady();}
      else if(pending&&value.request===pending.id&&value.complete){const current=pending;pending=undefined;clearTimeout(current.timer);current.resolve();}
    }
  });
  child.stderr.on("data",data=>{
    stderr=(stderr+data.toString()).slice(-4000);progressLines+=data.toString();const lines=progressLines.split("\n");progressLines=lines.pop().slice(-4000);
    for(const line of lines){try{const row=JSON.parse(line);if(row.total)pending?.progress?.(row.completed/row.total);}catch{}}
  });
  return {
    async request({cells,output,incumbents="-",start,end,step,filter=false,progress,timeoutMs=timeout}){
      await ready;if(closed||signal?.aborted)throw new Error("Job cancelled or native worker closed");if(pending)throw new Error("Concurrent requests on one native worker");
      const paths=[cells,output,incumbents].map(path=>{const bytes=Buffer.from(path);if(!bytes.length||bytes.length>4096||bytes.includes(0))throw new Error("Invalid native worker path");return bytes;});
      const id=++sequence,header=Buffer.alloc(48);header.write("SGQ1");header.writeUInt32LE(id,4);header.writeDoubleLE(start,8);header.writeDoubleLE(end,16);header.writeDoubleLE(step,24);header.writeUInt32LE(filter?1:0,32);paths.forEach((path,i)=>header.writeUInt32LE(path.length,36+i*4));
      await new Promise((resolve,reject)=>{pending={id,resolve,reject,progress,timer:setTimeout(()=>stop(new Error("Native search timed out")),timeoutMs)};child.stdin.write(Buffer.concat([header,...paths]),error=>{if(error)stop(error);});});
    },
    async close(){
      if(closed)return;if(pending){stop();await ended;return;}
      closed=true;clearTimeout(startup);signal?.removeEventListener("abort",aborted);child.stdin.end();
      const timer=setTimeout(()=>{closed=false;stop();},3000);await ended;clearTimeout(timer);
    }
  };
}
