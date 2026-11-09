import {createWriteStream} from "node:fs";
import {unlink} from "node:fs/promises";
import {createHash} from "node:crypto";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";

// Backpressure bounds memory independently of file size. Never buffer an upload
// with Buffer.concat: recordings can be larger than RAM or the V8 buffer limit.
export async function saveUpload(source, path) {
  const hash=createHash("sha256");let bytes=0,created=false;
  const output=createWriteStream(path,{flags:"wx"});output.once("open",()=>{created=true;});
  try {
    await pipeline(source,new Transform({transform(chunk,encoding,done){bytes+=chunk.length;hash.update(chunk);done(null,chunk);}}),output);
    if(bytes<128)throw new Error("Empty media upload");
    return {bytes,sha256:hash.digest("hex")};
  } catch(error) {
    if(created)await unlink(path).catch(()=>{});
    throw error;
  }
}
