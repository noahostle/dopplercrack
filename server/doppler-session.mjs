import {mkdir,readdir,lstat,realpath,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
const uuid=/^[a-f0-9-]{36}$/;
async function removeOwned(base,name){
  const parent=resolve(base),target=resolve(parent,name);
  if(dirname(target)!==parent)throw new Error('Invalid temporary workspace path');
  try{
    const info=await lstat(target),actual=await realpath(target);
    const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    if(!info.isDirectory()||info.isSymbolicLink()||!equal(actual,target))throw new Error('Refusing redirected temporary workspace');
    await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }catch(error){if(error.code!=='ENOENT')throw error;}
}
export function sessionWorkspace(base){
  const name=`${process.pid}-${randomUUID()}`,root=join(resolve(base),name);
  return {root,
    async initialize(){
      await mkdir(base,{recursive:true});
      // Only our process-named workspaces are eligible; active servers remain.
      for(const entry of await readdir(base,{withFileTypes:true})){
        const match=/^(\d+)-([a-f0-9-]{36})$/.exec(entry.name);
        if(!entry.isDirectory()||entry.isSymbolicLink()||!match)continue;
        let alive=true;try{process.kill(Number(match[1]),0);}catch(error){if(error.code==='ESRCH')alive=false;}
        if(!alive)await removeOwned(base,entry.name);
      }
      await mkdir(root,{recursive:true});
    },
    async removeJob(id){if(!uuid.test(id))throw new Error('Invalid temporary job ID');await removeOwned(root,id);},
    async close(){await removeOwned(base,name);}
  };
}
