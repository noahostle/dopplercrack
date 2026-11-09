// Browser workflow checks use API fixtures. No AI, YouTube, map providers or
// real archive deletions are called. Requires Chrome and a production build.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startDopplerApp} from '../server/app.mjs';
const app=await startDopplerApp({port:0});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},timezoneId:'Australia/Sydney'}),errors=[],writes=[];
const outputs=fileURLToPath(new URL('../outputs/ui/',import.meta.url));await mkdir(outputs,{recursive:true});
page.on('pageerror',error=>errors.push(error.message));
const id='00000000-0000-4000-8000-000000000001';
const originalJob={id,state:'selecting',name:'YouTube timestamp control',progress:100,createdAt:new Date().toISOString(),sourceUrl:'https://www.youtube.com/watch?v=M7lc1UVf-VE',sourceRecordingTime:{utc:'2026-10-26T23:59:00Z'},media:{kind:'video',format:'YouTube',duration:1344,audioTracks:[]}};
let job={...originalJob};
const spectral=Buffer.alloc(64+25*3541);spectral.write('SGSPEC3');spectral.writeUInt32LE(25,8);spectral.writeUInt32LE(3541,12);
for(const[offset,value]of [[16,0],[24,.5],[32,15],[40,.25],[48,12],[56,1]])spectral.writeDoubleLE(value,offset);
const points=[];for(let t=0;t<25;t++){const hz=130-25*Math.tanh((t*.5-6)/3);if(t>1&&t<23)points.push([t*.5,hz,15]);for(let f=0;f<3541;f++)spectral[64+t*3541+f]=Math.round(3+23*Math.exp(-(((15+f*.25-hz)/1.5)**2))+2*Math.sin(t*.7+f*.2)**2);}
const event={id:1,start:1,end:11,dropHz:45,points};
const days=[{date:'2026-10-26',bytes:1024,files:2,complete:true},{date:'2026-10-27',bytes:2048,files:3,complete:false}];
const candidates=Array.from({length:10},(_,i)=>({lat:-33.86+i*.01,lon:151.2+i*.01,country:'AU',clock:Date.parse('2026-10-26T23:00:00Z')/1000,flights:[`TEST${i}`],score:30-i,relativeFit:1-i*.05,loss:i}));
await page.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(!['127.0.0.1','localhost'].includes(u.hostname))return route.abort();
  assert.ok(!u.pathname.startsWith('/api/brief'));
  if(u.pathname==='/api/doppler'){
    const action=u.searchParams.get('action');
    const reply=json=>route.fulfill({contentType:'application/json',body:JSON.stringify(json)});
    if(action==='cache')return reply({days,bytes:3072,files:5,busy:false});
    if(action==='spectrum')return route.fulfill({contentType:'application/octet-stream',body:spectral});
    if(request.method()==='POST'){
      if(action==='discard'||action==='touch')return reply({active:true});
      const data=request.postDataJSON();writes.push({action,data});
      if(action==='places')return reply({available:true,places:data.points.map(()=>({city:'Sydney',state:'New South Wales',country:'Australia',label:'Sydney, New South Wales, Australia',approximate:true,distanceKm:1.2}))});
      if(action==='clear-cache'){assert.deepEqual(data,{dates:['2026-10-26']});return reply({days:[days[1]],bytes:2048,files:3,busy:false,cleared:{bytes:1024,files:2}});}
      if(action==='segment'){job={...job,state:'ready',duration:data.end-data.start,detectorVersion:4,segment:data,spectrumReady:true,events:[event],language:{code:'en',name:'English'}};return reply(job);}
      if(action==='estimate'){job={...job,estimate:{plan:{clockTrials:data.recordingStart.mode==='exact'?1:6483,archiveDays:['2026-10-26']},missingArchiveDays:[]}};return reply(job);}
      if(action==='search'){assert.equal(data.recordingStart.mode,'range');assert.equal(data.recordingStart.stepSeconds,5);job={...job,state:'complete',result:{scoreMode:'spectral',cellsEvaluated:100,leaderboard:candidates,candidates,coverage:[],limitations:[]}};return reply(job);}
      assert.equal(data.url,job.sourceUrl);return reply(job);
    }
    if(u.searchParams.get('job')===id)return reply(job);
    return reply({available:true,language:true});
  }
  return route.continue();
});
try{
  await page.goto(app.url);
  assert.equal(await page.getByLabel('Recording timezone').inputValue(),'Australia/Sydney');
  assert.equal(await page.getByText('Select at least one country on the map or using search.',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Open glass cover'}).getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('.dc-country-options').count(),0,'A fresh page must not list countries before typing');
  await page.getByLabel('Search countries').fill('   ');assert.equal(await page.locator('.dc-country-options').count(),0,'Whitespace is an empty query');await page.getByLabel('Search countries').fill('');
  await page.getByRole('button',{name:'Open glass cover'}).click();assert.equal(await page.getByRole('button',{name:'GO',exact:true}).isDisabled(),true,'Missing inputs keep GO locked');
  assert.equal(await page.getByRole('button',{name:'Open glass cover'}).getAttribute('aria-expanded'),'false','A locked cover budges without opening');
  assert.ok(await page.locator('.dc-switch-cover').evaluate(element=>element.getAnimations().some(animation=>animation.playState==='running')),'The locked cover must visibly budge');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Open glass cover'}).getAttribute('aria-expanded'),'false');
  const panel=await page.getByRole('heading',{name:/SYSTEM READY/}).boundingBox(),recording=await page.getByRole('heading',{name:/01 Recording/}).boundingBox();assert.ok(panel.y<recording.y,'System console must be above the input panels');
  await page.screenshot({path:outputs+'initial.png',fullPage:true});
  await page.getByLabel('Start date',{exact:true}).fill('2026-10-27');
  await page.getByLabel('Start time',{exact:true}).fill('09:59:00');
  assert.equal(await page.getByLabel('Latest start time',{exact:true}).isDisabled(),true);
  await page.getByLabel('YouTube link').fill(job.sourceUrl);
  await page.getByRole('button',{name:'Load YouTube details'}).click();
  await page.getByLabel('Clip start',{exact:true}).waitFor();
  assert.equal(writes.length,1,'Metadata must not trigger a clip download');
  assert.equal(await page.getByLabel('Start time',{exact:true}).inputValue(),'09:59:00','Loading media must preserve entered recording times');
  assert.equal(await page.locator('iframe').count(),0,'YouTube preview is opt-in');
  await page.getByLabel('Clip start',{exact:true}).fill('00:10:00');await page.getByLabel('Clip end',{exact:true}).fill('00:10:12');
  await page.getByRole('button',{name:'DOWNLOAD & ANALYZE AUDIO'}).click();await page.getByText('English',{exact:true}).waitFor();
  await page.locator('.dc-spectrum canvas').waitFor();await page.waitForFunction(()=>document.querySelector('.dc-spectrum canvas')?.width>0);
  const overlaid=await page.locator('.dc-spectrum canvas').evaluate(canvas=>canvas.toDataURL());
  await page.getByLabel('Show curves',{exact:true}).uncheck();await page.waitForFunction(before=>document.querySelector('.dc-spectrum canvas').toDataURL()!==before,overlaid);
  await page.getByLabel('Show curves',{exact:true}).check();await page.getByRole('button',{name:/Curve 1/}).click();
  await page.getByRole('button',{name:'Full spectrum',exact:true}).click();await page.getByRole('button',{name:'Detected band',exact:true}).click();
  assert.deepEqual(writes.find(w=>w.action==='segment').data,{start:600,end:612});
  await page.getByLabel('Search countries').fill('Australia');await page.locator('.dc-country-options').getByRole('button',{name:'Australia',exact:true}).click();
  await page.getByLabel('Search countries').fill('');assert.equal(await page.locator('.dc-country-options').count(),0,'Clearing the query hides suggestions even with a selected country');
  await page.locator('.dc-readiness [data-ready="true"]').nth(5).waitFor();
  await page.locator('.dc-recording-start .dc-estimate').getByText('1 possible start',{exact:true}).waitFor();
  assert.equal(await page.locator('.dc-launch .dc-estimate').count(),0,'Search estimates belong beneath Recording start');
  assert.equal(await page.getByRole('button',{name:'GO',exact:true}).isDisabled(),true,'GO stays covered until explicitly opened');
  await page.locator('.dc-launch').screenshot({path:outputs+'switch-closed.png',animations:'disabled'});
  await page.getByRole('button',{name:'Open glass cover'}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'GO',exact:true}).isEnabled(),true);
  assert.equal(writes.filter(write=>write.action==='search').length,0,'Opening the cover never starts a search');
  await page.locator('.dc-launch').screenshot({path:outputs+'switch-open.png',animations:'disabled'});
  await page.getByLabel('Start time',{exact:true}).fill('');assert.equal(await page.getByRole('button',{name:'Open glass cover'}).getAttribute('aria-expanded'),'false','An incomplete input closes the guard');
  await page.getByLabel('Start time',{exact:true}).fill('09:59:00');await page.getByRole('button',{name:'Open glass cover'}).click();
  await page.screenshot({path:outputs+'desktop.png',fullPage:true});
  await page.getByRole('switch',{name:'Search a start-time range'}).check();
  await page.getByLabel('Start date',{exact:true}).fill('2026-10-25');await page.getByLabel('Last date',{exact:true}).fill('2026-10-27');
  await page.getByLabel('Start time',{exact:true}).fill('07:00:00');await page.getByLabel('Latest start time',{exact:true}).fill('10:00:00');
  await page.getByLabel('Start-time interval').selectOption('5');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:outputs+'mobile.png',fullPage:true,animations:'disabled'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1100});await page.getByRole('button',{name:'GO',exact:true}).hover();await page.mouse.down();
  await page.waitForFunction(()=>new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.dc-push-cap')).transform).m42===0);
  await page.locator('.dc-launch').screenshot({path:outputs+'switch-pressed.png',animations:'disabled'});await page.mouse.up();
  await page.locator('.dc-leaderboard li').nth(9).waitFor();assert.equal(await page.locator('.dc-leaderboard li').count(),10);
  assert.equal(await page.getByRole('button',{name:'Open glass cover'}).getAttribute('aria-expanded'),'false','The cover closes after activation');
  await page.locator('.dc-leaderboard').getByText('Near Sydney, New South Wales, Australia',{exact:true}).first().waitFor();
  assert.equal(await page.locator('.dc-leaderboard').getByText('AU · TEST0',{exact:false}).count(),0);
  await page.screenshot({path:outputs+'results.png',fullPage:true});
  await page.locator('.dc-leaderboard button').first().click();await page.getByRole('dialog').waitFor();assert.ok(await page.locator('.dc-map-pin').count());await page.getByRole('dialog').getByRole('heading',{name:'Near Sydney, New South Wales, Australia'}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Archive cache'}).click();const dialog=page.getByRole('dialog',{name:'ADS-B archive cache'});
  assert.equal(await dialog.getByText('Flight archive coverage in',{exact:false}).count(),0);
  await dialog.getByRole('checkbox',{name:/2026-10-26/}).check();assert.equal(await dialog.getByRole('checkbox',{name:/2026-10-27/}).isChecked(),false);
  await page.screenshot({path:outputs+'cache.png',fullPage:true});await dialog.getByRole('button',{name:/Clear 1 selected days/}).click();await dialog.getByText(/Cleared 2 files/).waitFor();
  assert.equal(await dialog.getByRole('checkbox').count(),1);await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  assert.equal(await page.getByText('Saved analysis uses the earlier detector',{exact:false}).count(),0);
  assert.equal(await page.locator('.dc-readiness > p').count(),0);
  for(const removed of ['yt-dlp fetches only the selected audio.','Choose timestamps · audio not downloaded','Open original video','· 8 seconds–30 minutes per analysis','ETA updates after the first search batch.','SEARCH INTERLOCKS','Top locations','DOPPLERCRACK / 05','Measured audio · detected paths overlaid','Select a curve to inspect it. Contrast changes the display only.'])assert.equal(await page.getByText(removed,{exact:false}).count(),0,removed);
  await page.reload();assert.equal(await page.locator('.dc-file').count(),0,'Reloading must not restore a recording or result');assert.equal(await page.locator('.dc-country-options').count(),0,'Country suggestions stay hidden after refresh');
  job={...originalJob};await page.getByLabel('YouTube link').fill(job.sourceUrl);await page.getByRole('button',{name:'Load YouTube details'}).click();await page.getByLabel('Clip start',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Recording timezone').inputValue(),'Australia/Sydney');assert.equal(await page.getByLabel('Start date',{exact:true}).inputValue(),'2026-10-27');assert.equal(await page.getByLabel('Start time',{exact:true}).inputValue(),'10:59:00');
  assert.deepEqual(errors,[]);
  console.log('Metadata-first intake, local timezone/DST display, top readiness console, exact/ranged starts, spectrogram/curve controls, desktop/mobile layout, locality labels, top ten, map focus, imagery fallback, cache selection and fresh reload passed.');
}finally{await browser.close();await app.close();}
