import {publicMediaUrl} from './doppler-media.mjs';

// Parse data, never execute page scripts. Playback URLs/deciphering are not
// needed to display a title, duration and timestamp controls.
export function youtubePageInfo(html,expectedId){
  const match=/\bytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if(!match)throw new Error('YouTube page metadata unavailable');
  const start=match.index+match[0].lastIndexOf('{');let depth=0,quoted=false,escaped=false,end=start;
  for(;end<html.length;end++){
    const char=html[end];
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
    else if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&!--depth){end++;break;}
  }
  const response=JSON.parse(html.slice(start,end)),details=response.videoDetails;
  if(response.playabilityStatus?.status!=='OK'||details?.videoId!==expectedId||!details.title||!(Number(details.lengthSeconds)>0))throw new Error('YouTube video details unavailable');
  if(response.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow)throw new Error('Choose a recorded video, not a live stream');
  return {id:details.videoId,title:details.title,duration:Number(details.lengthSeconds),extractor_key:'YouTube',is_live:false};
}
export async function fastYouTubeInfo(url,signal,fetcher=fetch){
  const canonical=publicMediaUrl(url),requestSignal=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  const response=await fetcher(canonical,{signal:requestSignal,redirect:'error',headers:{'Accept':'text/html','Accept-Language':'en'}});
  if(!response.ok)throw new Error(`YouTube metadata HTTP ${response.status}`);
  const reader=response.body.getReader(),decoder=new TextDecoder();let html='',bytes=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024)throw new Error('YouTube metadata page is too large');html+=decoder.decode(value,{stream:true});}html+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});}
  return youtubePageInfo(html,new URL(canonical).searchParams.get('v'));
}
