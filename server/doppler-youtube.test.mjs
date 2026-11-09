import test from 'node:test';import assert from 'node:assert/strict';
import {youtubePageInfo,fastYouTubeInfo} from './doppler-youtube.mjs';
const id='M7lc1UVf-VE',info={playabilityStatus:{status:'OK'},videoDetails:{videoId:id,title:'An escaped "title" with {braces}',lengthSeconds:'1344'}};
const html=value=>`<script>var ytInitialPlayerResponse = ${JSON.stringify(value)}; window.doNotExecute();</script>`;
test('Fast metadata reads balanced JSON without executing scripts or resolving streams',async()=>{
  assert.equal(youtubePageInfo(html(info),id).title,info.videoDetails.title);
  const found=await fastYouTubeInfo(`https://youtu.be/${id}`,undefined,async(url,options)=>{assert.equal(url,`https://www.youtube.com/watch?v=${id}`);assert.equal(options.redirect,'error');return new Response(html(info));});
  assert.equal(found.duration,1344);assert.equal(found.extractor_key,'YouTube');
  for(const value of[{...info,playabilityStatus:{status:'LOGIN_REQUIRED'}},{...info,videoDetails:{...info.videoDetails,videoId:'wrong'}},{...info,microformat:{playerMicroformatRenderer:{liveBroadcastDetails:{isLiveNow:true}}}}])assert.throws(()=>youtubePageInfo(html(value),id));
  assert.throws(()=>youtubePageInfo('no data',id));
});
