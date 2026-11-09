// Run-scoped immutable source snapshot, with a disk-backed time index. Clock
// batches retain the reference selection, duplicate precedence and output order.
import {createReadStream} from "node:fs";
import {open,mkdir,readFile,readdir,stat} from "node:fs/promises";
import {createInterface} from "node:readline";
import {join,dirname} from "node:path";
import {gunzipSync} from "node:zlib";
import {createHash,randomUUID} from "node:crypto";
import {dataRoot,trackFiles,parseCsv,readsbRows,nearSelection,isKnownJet} from "./doppler-data.mjs";

const dayOf=t=>new Date(t*1000).toISOString().slice(0,10);
const archiveDate=path=>path.replaceAll("\\","/").match(/\/(\d{4}-\d{2}-\d{2})-[a-f0-9]{6}\.json$/i)?.[1];
const stride=56;
export async function createTrackStore(settings,csv,{root=dataRoot,folder,signal,update=()=>{},cacheBytes=128*2**20,maxBytes=8*2**30}={}){
  if(!folder)throw new Error("A private job folder is required for the track snapshot");
  await mkdir(root,{recursive:true});await mkdir(folder,{recursive:true});
  const path=join(folder,`tracks-${randomUUID()}.bin`),handle=await open(path,"wx+");
  const manifest=[],entries=[],indexed=new Set(),ids=[],idMap=new Map(),cache=new Map(),complete=new Map();
  const hash=createHash("sha256"),allowed=settings.allowedArchiveDays&&new Set(settings.allowedArchiveDays);
  const first=dayOf(settings.start-600),last=dayOf(settings.end+settings.duration+600);
  let bytes=0,cachedBytes=0,closed=false,timeIndex,jetsByDay=new Map(),sourceReads=0,blockReads=0,queries=0;
  const jetQueries=new Map();
  const check=()=>{if(signal?.aborted)throw new Error("Job cancelled");if(closed)throw new Error("Track snapshot closed");};
  const eligible=(file,window)=>!file.day||(file.day>=dayOf(window.start-600)&&file.day<=dayOf(window.end+window.duration+600)&&(!allowed||allowed.has(file.day)));
  async function pack(items,file){
    for(const row of items)if(isKnownJet(row))file.jets.add(row[0]);
    const rows=items.map((row,order)=>({row,order})).filter(({row})=>nearSelection(row,settings)&&(!allowed||allowed.has(dayOf(row[1]))));
    if(!rows.length)return;
    rows.sort((a,b)=>a.row[1]-b.row[1]);
    const buffer=Buffer.allocUnsafe(rows.length*stride);
    for(let i=0;i<rows.length;i++){
      const {row,order}=rows[i];if(!idMap.has(row[0])){idMap.set(row[0],ids.length);ids.push(row[0]);}
      const desc=row.length<6?-1:row[5]?row[5].charCodeAt(0)*65536+row[5].charCodeAt(1)*256+row[5].charCodeAt(2):0;
      const values=[idMap.get(row[0]),row[1],row[2],row[3],row[4],desc,order];
      for(let k=0;k<7;k++)buffer.writeDoubleLE(values[k],i*stride+k*8);
    }
    if(bytes+buffer.length>maxBytes)throw new Error("Track snapshot disk budget exceeded; narrow date range or region");
    // write() may be short on any OS; finish the complete block before indexing it.
    for(let done=0;done<buffer.length;){const result=await handle.write(buffer,done,buffer.length-done,bytes+done);if(!result.bytesWritten)throw new Error("Cannot write track snapshot");done+=result.bytesWritten;}
    entries.push({offset:bytes,length:buffer.length,file,ordinal:entries.length,start:rows[0].row[1],end:rows.at(-1).row[1]});bytes+=buffer.length;
  }
  async function ingest(source,imported){
    check();if(indexed.has(source))return;
    const day=archiveDate(source);
    if(day&&(day<first||day>last||allowed&&!allowed.has(day)))return;
    if(day&&dirname(source)===join(root,"adsblol")){
      if(!complete.has(day)){try{await stat(join(root,"adsblol",`${day}.complete`));complete.set(day,true);}catch{complete.set(day,false);}}
      if(!complete.get(day))return;
    }
    if(manifest.length>=200000)throw new Error("Local archive file limit reached");
    const before=imported===undefined?await stat(source):undefined;
    if(before?.size>128*2**20)throw new Error("Split CSV files into chunks below 128 MB");
    const file={path:source,day,jets:new Set(),order:manifest.length};manifest.push(file);indexed.add(source);
    if(imported!==undefined){hash.update(imported);await pack(parseCsv(imported),file);}
    else{
      sourceReads++;hash.update(JSON.stringify([source,before.size,before.mtimeMs,before.ctimeMs]));
      if(/\.csv$/i.test(source)){
        const lines=createInterface({input:createReadStream(source),crlfDelay:Infinity});let header="",batch=[];
        try{for await(const line of lines){check();if(!header){header=line;continue;}batch.push(line);if(batch.length===4000){await pack(parseCsv(`${header}\n${batch.join("\n")}`),file);batch=[];}}if(batch.length)await pack(parseCsv(`${header}\n${batch.join("\n")}`),file);}finally{lines.close();}
      }else{
        const raw=await readFile(source),plain=/\.gz$/i.test(source)?gunzipSync(raw,{maxOutputLength:32_000_000}):raw;
        const rows=readsbRows(JSON.parse(plain.toString("utf8")));
        for(let i=0;i<rows.length;i+=4000)await pack(rows.slice(i,i+4000),file);
      }
      const after=await stat(source);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error(`Track source changed during snapshot: ${source}`);
    }
    if(!(manifest.length%250))update(`Snapshot indexed ${manifest.length} files; ${(bytes/2**20).toFixed(1)} MB of relevant positions`);
  }
  function rebuild(){
    // Centred interval tree: every overlap is reported once. Both branches
    // contain at most half the entries, giving O(log B + hits) range queries.
    const build=items=>{
      if(!items.length)return null;const center=items[items.length>>>1].start,left=[],right=[],overlap=[];
      for(const entry of items){if(entry.end<center)left.push(entry);else if(entry.start>center)right.push(entry);else overlap.push(entry);}
      return {center,byStart:overlap,byEnd:[...overlap].sort((a,b)=>b.end-a.end),left:build(left),right:build(right)};
    };
    timeIndex=build([...entries].sort((a,b)=>a.start-b.start||a.ordinal-b.ordinal));
    jetsByDay=new Map();jetQueries.clear();for(const file of manifest){if(!jetsByDay.has(file.day))jetsByDay.set(file.day,new Set());for(const id of file.jets)jetsByDay.get(file.day).add(id);}
  }
  async function block(entry){
    if(cache.has(entry)){const value=cache.get(entry);cache.delete(entry);cache.set(entry,value);return value;}
    const buffer=Buffer.allocUnsafe(entry.length);blockReads++;
    for(let done=0;done<buffer.length;){const result=await handle.read(buffer,done,buffer.length-done,entry.offset+done);if(!result.bytesRead)throw new Error("Truncated track snapshot");done+=result.bytesRead;}
    if(buffer.length<=cacheBytes){while(cachedBytes+buffer.length>cacheBytes&&cache.size){const key=cache.keys().next().value;cachedBytes-=cache.get(key).length;cache.delete(key);}cache.set(entry,buffer);cachedBytes+=buffer.length;}
    return buffer;
  }
  async function close(){if(closed)return;closed=true;cache.clear();await handle.close();}
  try{if(csv)await ingest("<imported CSV>",csv);for await(const source of trackFiles(root))await ingest(source);rebuild();}catch(error){await close();throw error;}
  return {
    get stats(){return {snapshotId:hash.copy().digest("hex"),sourceFiles:manifest.length,sourceReads,blockReads,queries,packedBytes:bytes,cachedBytes,indexBlocks:entries.length};},
    // Only newly completed downloads extend a snapshot; existing inputs remain
    // frozen. Each extension is included in the final provenance digest.
    async extendArchive(day){
      check();complete.delete(day);let names;try{names=await readdir(join(root,"adsblol"));}catch{return;}
      for(const name of names)if(name.startsWith(`${day}-`)&&/\.json$/i.test(name))await ingest(join(root,"adsblol",name));
      // Match the reference directory traversal's duplicate precedence when a
      // newly downloaded archive sorts before previously indexed local files.
      const byPath=new Map(manifest.map(file=>[file.path,file]));let order=csv?1:0;
      for await(const source of trackFiles(root)){const file=byPath.get(source);if(file)file.order=order++;}
      rebuild();
    },
    async query(window){
      check();if(window.start<settings.start||window.end>settings.end)throw new Error("Clock batch is outside the track snapshot range");queries++;const from=window.start-600,to=window.end+window.duration+600,key=`${dayOf(from)}:${dayOf(to)}`;
      if(!jetQueries.has(key)){const jets=new Set(jetsByDay.get(undefined));for(const [day,ids]of jetsByDay)if(day&&day>=dayOf(from)&&day<=dayOf(to)&&(!allowed||allowed.has(day)))for(const id of ids)jets.add(id);jetQueries.set(key,jets);}
      const jets=jetQueries.get(key),hits=[];
      const visit=node=>{
        if(!node)return;
        if(to<node.center){for(const entry of node.byStart){if(entry.start>to)break;if(eligible(entry.file,window))hits.push(entry);}visit(node.left);}
        else if(from>node.center){for(const entry of node.byEnd){if(entry.end<from)break;if(eligible(entry.file,window))hits.push(entry);}visit(node.right);}
        else{for(const entry of node.byStart)if(eligible(entry.file,window))hits.push(entry);visit(node.left);visit(node.right);}
      };visit(timeIndex);hits.sort((a,b)=>a.file.order-b.file.order||a.ordinal-b.ordinal);
      const rows=[],seen=new Set();
      for(const entry of hits){
        check();const buffer=await block(entry),selected=[];
        for(let i=0;i<buffer.length;i+=stride){
          const t=buffer.readDoubleLE(i+8);if(t<from)continue;if(t>to)break;
          const id=ids[buffer.readDoubleLE(i)],desc=buffer.readDoubleLE(i+40),row=[id,t,buffer.readDoubleLE(i+16),buffer.readDoubleLE(i+24),buffer.readDoubleLE(i+32)];
          if(desc>=0)row.push(desc?String.fromCharCode(Math.floor(desc/65536),Math.floor(desc/256)%256,desc%256):"");
          if(nearSelection(row,window)&&(!allowed||allowed.has(dayOf(t))))selected.push({row,order:buffer.readDoubleLE(i+48)});
        }
        selected.sort((a,b)=>a.order-b.order);
        for(const {row}of selected){const key=`${row[0]}:${row[1]}`;if(seen.has(key))continue;seen.add(key);rows.push(row);if(rows.length>2_000_000)throw new Error("Track memory budget reached; narrow time or region");}
      }
      const grouped=new Map();for(const row of rows){if(!grouped.has(row[0]))grouped.set(row[0],[]);grouped.get(row[0]).push(row);}
      const usable=[...grouped.values()].filter(group=>group.length>=8&&!jets.has(group[0][0])&&!group.some(isKnownJet));
      if(usable.length>6000)throw new Error("More than 6,000 aircraft; narrow the region or time");
      return usable.flatMap(group=>group.sort((a,b)=>a[1]-b[1]));
    },close
  };
}
