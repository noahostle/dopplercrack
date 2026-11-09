import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";

const defaultRoot=fileURLToPath(new URL("../runtime/terrain/",import.meta.url));
const geoidUrl="https://download.osgeo.org/proj/vdatum/egm96_15/egm96_15.gtx";
export function terrainTile(lat,lon){
  const south=Math.min(89,Math.floor(lat)),west=Math.floor(((lon+540)%360)-180);
  return {south,west,name:`${south<0?"S":"N"}${String(Math.abs(south)).padStart(2,"0")}${west<0?"W":"E"}${String(Math.abs(west)).padStart(3,"0")}`};
}
export function geoidHeight(buffer,lat,lon){
  if(buffer.length<40)throw new Error("Invalid EGM96 GTX header");
  const south=buffer.readDoubleBE(0),west=buffer.readDoubleBE(8),dy=buffer.readDoubleBE(16),dx=buffer.readDoubleBE(24),ny=buffer.readInt32BE(32),nx=buffer.readInt32BE(36);
  if(nx<2||ny<2||dx<=0||dy<=0||40+nx*ny*4!==buffer.length)throw new Error("Invalid EGM96 GTX grid");
  const x=(((lon-west)/dx)%nx+nx)%nx,y=(lat-south)/dy;if(y<0||y>ny-1)throw new Error("Coordinate outside geoid grid");
  const col=Math.floor(x),row=Math.min(ny-2,Math.floor(y)),u=x-col,v=y-row;
  const at=(r,c)=>buffer.readFloatBE(40+(r*nx+c%nx)*4);
  const value=(1-v)*((1-u)*at(row,col)+u*at(row,col+1))+v*((1-u)*at(row+1,col)+u*at(row+1,col+1));
  if(!Number.isFinite(value)||Math.abs(value)>200)throw new Error("Invalid geoid undulation");return value;
}
export function hgtHeight(buffer,lat,lon,tile){
  const n=Math.sqrt(buffer.length/2);if(![1201,3601].includes(n))throw new Error("DEM must be 1201 or 3601 square signed big-endian HGT");
  const x=(lon-tile.west)*(n-1),y=(tile.south+1-lat)*(n-1);
  if(x<-.00001||y<-.00001||x>n-1+.00001||y>n-1+.00001)throw new Error("Coordinate outside DEM tile");
  const col=Math.max(0,Math.min(n-2,Math.floor(x))),row=Math.max(0,Math.min(n-2,Math.floor(y))),u=x-col,v=y-row;
  const values=[buffer.readInt16BE((row*n+col)*2),buffer.readInt16BE((row*n+col+1)*2),buffer.readInt16BE(((row+1)*n+col)*2),buffer.readInt16BE(((row+1)*n+col+1)*2)];
  if(values.some(h=>h===-32768))throw new Error(`DEM void at ${lat}, ${lon}; provide a filled local HGT tile`);
  return (1-v)*((1-u)*values[0]+u*values[1])+v*((1-u)*values[2]+u*values[3]);
}
export function terrainProvider({mode="auto",altitude=0,root=defaultRoot,signal,update=()=>{},maxTiles=1024}={}){
  if(!["auto","local","constant"].includes(mode))throw new Error("Choose automatic DEM, local DEM or explicit constant ellipsoidal height");
  const cache=new Map(),sources=new Map();let geoid,downloads=0;
  async function cached(name,url,maxBytes){
    const path=join(root,name);let bytes;
    try{bytes=await readFile(path);}catch(error){
      if(error.code!=="ENOENT")throw error;
      if(mode!=="auto")throw new Error(`Missing terrain file ${name}. Put it in runtime/terrain/ or enable automatic DEM.`);
      if(++downloads>maxTiles)throw new Error("Terrain download budget reached; narrow the region or increase DOPPLER_TERRAIN_MAX_TILES");
      update(`Loading terrain ${name}`);const response=await fetch(url,{signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(90000)])});
      if(!response.ok)throw new Error(`Terrain ${name} unavailable (HTTP ${response.status}); provide local DEM data. No zero-height substitution was made.`);
      const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw new Error("Terrain tile exceeds its byte budget");chunks.push(chunk);}bytes=Buffer.concat(chunks);
      await mkdir(root,{recursive:true});const temporary=join(root,`${name}.${randomUUID()}.tmp`);await writeFile(temporary,bytes);await rename(temporary,path);
    }
    if(bytes.length>maxBytes)throw new Error("Terrain cache exceeds tile byte budget");
    sources.set(name,{name,url,sha256:createHash("sha256").update(bytes).digest("hex")});return bytes;
  }
  return {
    mode,sources,
    async apply(cells){
      if(mode==="constant")return cells.map(cell=>[cell[0],cell[1],altitude,...cell.slice(3)]);
      geoid ||= await cached("egm96_15.gtx",geoidUrl,5_000_000);
      const groups=new Map();for(const cell of cells){const tile=terrainTile(cell[0],cell[1]);if(!groups.has(tile.name))groups.set(tile.name,{tile,cells:[]});groups.get(tile.name).cells.push(cell);}
      for(const {tile,cells:group} of groups.values()){
        if(signal?.aborted)throw new Error("Job cancelled");let buffer=cache.get(tile.name);
        if(!buffer){const raw=await cached(`${tile.name}.hgt.gz`,`https://elevation-tiles-prod.s3.amazonaws.com/skadi/${tile.name.slice(0,3)}/${tile.name}.hgt.gz`,28_000_000);buffer=gunzipSync(raw,{maxOutputLength:26_000_000});if(cache.size===3)cache.delete(cache.keys().next().value);cache.set(tile.name,buffer);}
        for(const cell of group)cell[2]=hgtHeight(buffer,cell[0],cell[1],tile)+geoidHeight(geoid,cell[0],cell[1]);
      }return cells;
    }
  };
}
