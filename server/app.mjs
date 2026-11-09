import {projectRoot,localPort} from "./config.mjs";
import {createServer} from "node:http";
import {randomBytes} from "node:crypto";
import {once} from "node:events";
import {existsSync,createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {Readable} from "node:stream";
import {join,resolve,extname,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {handleDopplerApi} from "./api.mjs";

const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};
export async function startDopplerApp({port=localPort(process.env.DOPPLER_PORT,3857),runnerPort=localPort(process.env.DOPPLER_RUNNER_PORT,0),secret=process.env.DOPPLER_RUNNER_SECRET||randomBytes(32).toString("hex"),mapsKey=process.env.GOOGLE_MAPS_BROWSER_KEY||"",dev=false}={}){
  const {startDopplerRunner,dopplerStatus}=await import("./doppler-runner.mjs");
  const runner=startDopplerRunner({port:runnerPort,secret});await once(runner,"listening");
  const endpoint=`http://127.0.0.1:${runner.address().port}`,dist=join(projectRoot,"dist");let vite;
  const server=createServer(async(req,res)=>{
    res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Content-Security-Policy","frame-ancestors 'self' http://127.0.0.1:* http://localhost:*");
    const send=(status,value)=>{res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
    try{
      const base=new URL(`http://${req.headers.host||"127.0.0.1"}`);if(!["127.0.0.1","localhost"].includes(base.hostname))return send(403,{error:"Loopback host required"});
      const url=new URL(req.url,base);
      if(req.method==="GET"&&url.pathname==="/health")return send(200,{application:"dopplercrack",version:"0.5.0",...dopplerStatus(),uiReady:dev||existsSync(join(dist,"index.html"))});
      if(url.pathname==="/api/doppler"){
        const controller=new AbortController();req.once("aborted",()=>controller.abort());res.once("close",()=>{if(!res.writableEnded)controller.abort();});
        const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);
        const request=new Request(url,{method:req.method,headers,signal:controller.signal,...(!["GET","HEAD"].includes(req.method)?{body:Readable.toWeb(req),duplex:"half"}:{})});
        const response=await handleDopplerApi(request,{endpoint,secret,mapsKey});res.writeHead(response.status,Object.fromEntries(response.headers));
        if(response.body){const stream=Readable.fromWeb(response.body);res.on("close",()=>stream.destroy());stream.on("error",()=>res.destroy()).pipe(res);}else res.end();return;
      }
      if(!["GET","HEAD"].includes(req.method))return send(405,{error:"Method not allowed"});
      if(vite)return vite.middlewares(req,res,()=>send(404,{error:"Not found"}));
      if(!existsSync(join(dist,"index.html")))return send(503,{error:"Build the standalone interface with npm run build in dopplercrack, or use npm run dev."});
      const pathname=decodeURIComponent(url.pathname);if(pathname.startsWith("/."))return send(404,{error:"Not found"});
      let file=resolve(dist,`.${pathname}`);if(file!==dist&&!file.startsWith(dist+sep))return send(403,{error:"Invalid path"});
      let info;try{info=await stat(file);}catch{}
      if(!info?.isFile()){if(extname(pathname))return send(404,{error:"Not found"});file=join(dist,"index.html");info=await stat(file);}
      res.writeHead(200,{"Content-Type":mime[extname(file)]||"application/octet-stream","Content-Length":info.size,"Cache-Control":"no-cache"});if(req.method==="HEAD")return res.end();
      const stream=createReadStream(file);res.on("close",()=>stream.destroy());stream.on("error",()=>res.destroy()).pipe(res);
    }catch(error){if(res.headersSent)res.destroy();else send(500,{error:error.message});}
  });
  server.requestTimeout=0;
  try{
    if(dev){const {createServer:createVite}=await import("vite");vite=await createVite({root:projectRoot,server:{middlewareMode:true,hmr:{server}},appType:"spa"});}
    server.listen(port,"127.0.0.1");await once(server,"listening");
  }catch(error){await vite?.close();runner.close();throw error;}
  let closed=false;
  return {server,runner,endpoint,secret,url:`http://127.0.0.1:${server.address().port}`,async close(){if(closed)return;closed=true;await vite?.close();server.closeAllConnections();runner.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>runner.close(resolve))]);await runner.cleanup;}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=await startDopplerApp({dev:process.argv.includes("--dev")});console.log(`Dopplercrack: ${app.url}`);
  for(const signal of["SIGINT","SIGTERM"])process.once(signal,()=>void app.close());
}
