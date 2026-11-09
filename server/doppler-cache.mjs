import {readdir,lstat,realpath,unlink} from "node:fs/promises";
import {resolve,join,dirname} from "node:path";

const owned=/^(\d{4}-\d{2}-\d{2})(?:-([a-f0-9]{6})\.json|\.complete)$/i;
const validDay=day=>typeof day==="string"&&/^20\d{2}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
async function verifiedRoot(root){
  const path=resolve(root);
  try{
    const info=await lstat(path),actual=await realpath(path);
    const equal=(a,b)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
    if(!info.isDirectory()||info.isSymbolicLink()||!equal(actual,path))throw new Error("Archive cache must be a real directory inside the configured data folder");
    return path;
  }catch(error){if(error.code==="ENOENT")return null;throw error;}
}
async function pool(items,work){
  let cursor=0;
  const results=await Promise.allSettled(Array.from({length:Math.min(32,items.length)},async()=>{while(cursor<items.length){const item=items[cursor++];await work(item);}}));
  const failed=results.find(result=>result.status==="rejected");if(failed)throw failed.reason;
}
export async function archiveInventory(root){
  const path=await verifiedRoot(root),days=new Map();
  if(!path)return {days:[],bytes:0,files:0};
  const entries=await readdir(path,{withFileTypes:true});
  await pool(entries,async entry=>{
    const match=owned.exec(entry.name);if(!match||!validDay(match[1])||!entry.isFile()||entry.isSymbolicLink())return;
    const info=await lstat(join(path,entry.name));if(!info.isFile()||info.isSymbolicLink())return;
    const day=days.get(match[1])||{date:match[1],bytes:0,files:0,complete:false};
    day.bytes+=info.size;day.files++;if(!match[2])day.complete=true;days.set(day.date,day);
  });
  const rows=[...days.values()].sort((a,b)=>b.date.localeCompare(a.date));
  return {days:rows,bytes:rows.reduce((sum,d)=>sum+d.bytes,0),files:rows.reduce((sum,d)=>sum+d.files,0)};
}
export async function clearArchiveDays(root,days){
  if(!Array.isArray(days)||!days.length||days.length>3660||days.some(day=>!validDay(day)))throw new Error("Select valid archive dates to clear");
  const path=await verifiedRoot(root),selected=new Set(days);let bytes=0,files=0;
  if(!path)return {dates:[...selected],bytes,files};
  const entries=await readdir(path,{withFileTypes:true});
  const targets=entries.filter(entry=>{const match=owned.exec(entry.name);return entry.isFile()&&!entry.isSymbolicLink()&&match&&selected.has(match[1]);});
  async function remove(entry){
    const target=resolve(path,entry.name);
    if(dirname(target)!==path)throw new Error("Archive path escaped its cache directory");
    try{
      const info=await lstat(target);if(!info.isFile()||info.isSymbolicLink())return;
      await unlink(target);bytes+=info.size;files++;
    }catch(error){if(error.code!=="ENOENT")throw error;}
  }
  // Invalidate completion markers first. An interrupted cleanup must never
  // leave a partially deleted day looking complete to the next search.
  await pool(targets.filter(entry=>entry.name.endsWith(".complete")),remove);
  await pool(targets.filter(entry=>!entry.name.endsWith(".complete")),remove);
  return {dates:[...selected],bytes,files};
}
