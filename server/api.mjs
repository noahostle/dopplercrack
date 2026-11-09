// Browser API, independent of any web framework. The private runner bearer
// token is added here and is never included in HTML, scripts or health output.
import {request as httpRequest} from "node:http";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {lookupPlaces} from "./doppler-places.mjs";

function streamToRunner(url,body,headers,signal){
  // Node's fetch has a finite response-header timeout. A large local upload can
  // legitimately take longer, so use a streaming HTTP request without that cap.
  return new Promise((resolve,reject)=>{
    const outgoing=httpRequest(url,{method:"POST",headers,signal},incoming=>{
      resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:{"Content-Type":"application/json"}}));
    });
    outgoing.on("error",reject);
    void pipeline(Readable.fromWeb(body),outgoing).catch(error=>{outgoing.destroy(error);reject(error);});
  });
}
export async function handleDopplerApi(request,{endpoint,secret,mapsKey=""}){
  const query=new URL(request.url).searchParams,id=query.get("job"),action=query.get("action");
  const json=(status,value)=>Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
  async function forward(path,method="GET",body,extra={}){
    const url=new URL(path,endpoint),headers={Authorization:`Bearer ${secret}`,...extra};
    const response=body instanceof ReadableStream?await streamToRunner(url,body,headers,request.signal):await fetch(url,{method,body,headers,redirect:"manual",signal:AbortSignal.any([request.signal,AbortSignal.timeout(180000)])});
    if(/\/(audio|source|preview|spectrum)$/.test(path)){
      const headers=new Headers({"Cache-Control":"no-store"});for(const key of["Content-Type","Content-Length","Accept-Ranges","Content-Range"]){const value=response.headers.get(key);if(value)headers.set(key,value);}return new Response(response.body,{status:response.status,headers});
    }
    const result=await response.json();if(path==="/health")result.mapsKey=mapsKey;return json(response.status,result);
  }
  try{
    if(request.method==="GET"){
      if(action==="cache"&&!id)return forward("/cache");
      if(!id)return forward("/health");if(!/^[a-f0-9-]{36}$/.test(id))return json(400,{error:"Invalid job"});
      const media=["audio","source","preview","spectrum"].includes(action);return forward(`/jobs/${id}${media?`/${action}`:""}`,"GET",undefined,media&&request.headers.has("range")?{Range:request.headers.get("range")}:{ });
    }
    if(request.method!=="POST")return json(405,{error:"Use GET or POST"});
    const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json(403,{error:"Cross-origin request rejected"});
    if(action==="places"&&!id){
      const raw=await request.text();if(raw.length>4000)return json(413,{error:"Too many location coordinates"});
      try{return json(200,await lookupPlaces(JSON.parse(raw).points));}catch(error){return json(400,{error:error.message});}
    }
    if(action==="clear-cache"&&!id){const raw=await request.text();if(raw.length>64000)return json(413,{error:"Too many archive dates"});return forward("/cache/clear","POST",raw,{"Content-Type":"application/json"});}
    if(["search","estimate","refine","segment","cancel","discard","touch"].includes(action)){
      if(!/^[a-f0-9-]{36}$/.test(id||""))return json(400,{error:"Invalid job ID"});
      let raw=["cancel","discard","touch"].includes(action)?"{}":await request.text();if(raw.length>(action==="segment"?4000:28000000))return json(413,{error:"Request payload too large"});
      if(["search","estimate"].includes(action))raw=JSON.stringify({...JSON.parse(raw),automatic:true});
      return forward(`/jobs/${id}/${action}`,"POST",raw,{"Content-Type":"application/json"});
    }
    if(action&&action!=="analyze")return json(400,{error:"Unknown action"});
    if(request.headers.get("content-type")?.startsWith("application/json")){
      const raw=await request.text();if(raw.length>4000)return json(413,{error:"URL request too large"});return forward("/jobs","POST",raw,{"Content-Type":"application/json","X-Doppler-Automatic":"1"});
    }
    if(!request.headers.get("content-type")?.startsWith("application/octet-stream")||!request.body)return json(400,{error:"A binary audio/video upload is required"});
    const name=request.headers.get("x-media-name")||"recording.bin";if(name.length>1000)return json(400,{error:"Filename too long"});
    return forward("/jobs","POST",request.body,{"Content-Type":"application/octet-stream","X-Media-Name":name,"X-Doppler-Automatic":"1"});
  }catch(error){return json(503,{error:error.message||"Dopplercrack request failed"});}
}
