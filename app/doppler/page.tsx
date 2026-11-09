"use client";
import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {ArrowUpRight,AudioLines,Check,ChevronRight,Crosshair,Database,Download,FileVideo,Globe2,Radio,Search,Upload,X} from "lucide-react";
import {DopplerMap} from "../../components/doppler-map";
import {DopplerLocationView} from "../../components/doppler-location-view";
import {DopplerClipSelector} from "../../components/doppler-clip-selector";
import {DopplerCacheMenu} from "../../components/doppler-cache-menu";
import {DopplerReadiness} from "../../components/doppler-readiness";
import {DopplerLaunchSwitch} from "../../components/doppler-launch-switch";
import {DopplerSpectrum} from "../../components/doppler-spectrum";
import {placeKey,useDopplerPlaces} from "../../components/use-doppler-places";
import {applyRecordingMetadata,browserTimeZone,formatRecordingClock} from "../../lib/doppler-clock.mjs";
import {readinessSteps} from "../../lib/doppler-readiness.mjs";
import {DopplerTimeControls,emptyDopplerTimeRange,formatDopplerDuration} from "../../components/doppler-time-controls";
import {DOPPLER_MEDIA_ACCEPT,mediaTime,youtubeId} from "../../lib/doppler-media.mjs";
import {embeddingOrigin} from "../../lib/bridge.mjs";
import type {DopplerCandidate,DopplerCountry,DopplerJob,DopplerRegion,DopplerSegment} from "../../lib/doppler-types";
type Health={available:boolean;language:boolean;mapsKey?:string;note?:string};
async function json<T=DopplerJob>(response:Response):Promise<T>{const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;}
const busyStates=["inspecting","analyzing","estimating","searching"];
export default function DopplerPage(){
  const[cacheOpen,setCacheOpen]=useState(false);
  const[countries,setCountries]=useState<DopplerCountry[]>([]),[selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState("");
  const[job,setJob]=useState<DopplerJob|null>(null),[health,setHealth]=useState<Health|null>(null),[source,setSource]=useState("");
  const[error,setError]=useState(""),[pending,setPending]=useState(false),[uploadProgress,setUploadProgress]=useState(0),[bounds,setBounds]=useState<DopplerRegion>();
  const[range,setRange]=useState(()=>({...emptyDopplerTimeRange,timeZone:browserTimeZone()})),[estimateKey,setEstimateKey]=useState(""),[chosen,setChosen]=useState<DopplerCandidate|null>(null),[attachNote,setAttachNote]=useState("");
  const upload=useRef<HTMLInputElement>(null),initial=useRef(false),filled=useRef(""),planned=useRef("");
  const uploadRequest=useRef<XMLHttpRequest|null>(null);
  const working=pending||!!job&&busyStates.includes(job.state),searching=job?.state==="searching",preparing=working&&!searching;
  const accept=useCallback((data:DopplerJob)=>{
    setJob(data);
    const metadata=data.sourceRecordingTime;
    if(filled.current!==data.id&&metadata&&(metadata.utc||metadata.local||metadata.date)){
      filled.current=data.id;
      setRange(value=>applyRecordingMetadata(value,metadata));
    }
  },[]);
  function remember(data:DopplerJob){accept(data);setChosen(null);}
  async function loadMedia(file?:File,url?:string){
    if(!file&&(!url||!youtubeId(url))){setError("Paste a YouTube video link.");return;}
    setPending(true);setError("");setChosen(null);setUploadProgress(0);setEstimateKey("");planned.current="";filled.current="";
    try{
      if(job)await fetch(`/api/doppler?job=${job.id}&action=discard`,{method:'POST'});
      setJob(null);
      let data:DopplerJob;
      if(file)data=await new Promise((resolve,reject)=>{const request=new XMLHttpRequest();uploadRequest.current=request;request.open("POST","/api/doppler");request.responseType="json";request.timeout=0;request.setRequestHeader("Content-Type","application/octet-stream");request.setRequestHeader("X-Media-Name",encodeURIComponent(file.name));request.upload.onprogress=e=>{if(e.lengthComputable)setUploadProgress(Math.round(e.loaded/e.total*100));};request.onload=()=>request.status>=200&&request.status<300?resolve(request.response):reject(Error(request.response?.error||"Upload failed"));request.onerror=()=>reject(Error("Upload connection failed"));request.onabort=()=>reject(Error("Upload cancelled"));request.send(file);});
      else data=await json(await fetch("/api/doppler",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})}));
      remember(data);
    }catch(cause){setError(cause instanceof Error?cause.message:"Unable to load recording");}finally{uploadRequest.current=null;setPending(false);}
  }
  useEffect(()=>{
    if(initial.current)return;initial.current=true;
    void fetch("/doppler/world.json").then(json<DopplerCountry[]>).then(setCountries).catch(e=>setError(e.message));
    void fetch("/api/doppler").then(json<Health>).then(setHealth).catch(e=>setError(e.message));
    const params=new URLSearchParams(window.location.search),url=params.get("source");
    if(params.has('job')){params.delete('job');window.history.replaceState(null,'',`/doppler?${params}`);}
    if(url){setSource(url);void loadMedia(undefined,url);}
  // Initial URL is consumed once; subsequent edits use explicit actions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const jobId=job?.id,jobState=job?.state;
  useEffect(()=>{const abort=()=>uploadRequest.current?.abort();window.addEventListener('pagehide',abort);return()=>window.removeEventListener('pagehide',abort);},[]);
  useEffect(()=>{
    if(!jobId)return;
    const release=()=>{navigator.sendBeacon(`/api/doppler?job=${jobId}&action=discard`);};
    const lease=setInterval(()=>{void fetch(`/api/doppler?job=${jobId}&action=touch`,{method:'POST'}).catch(()=>{});},60000);
    window.addEventListener('pagehide',release);
    return()=>{clearInterval(lease);window.removeEventListener('pagehide',release);};
  },[jobId]);
  useEffect(()=>{
    if(!jobId||!jobState||!busyStates.includes(jobState))return;
    let stopped=false,inFlight=false;const timer=setInterval(()=>{if(inFlight)return;inFlight=true;void fetch(`/api/doppler?job=${jobId}`,{cache:"no-store"}).then(json).then(data=>{if(!stopped)accept(data);}).catch(e=>{if(!stopped)setError(e.message);}).finally(()=>{inFlight=false;});},1000);
    return()=>{stopped=true;clearInterval(timer);};
  },[jobId,jobState,accept]);
  useEffect(()=>{const origin=embeddingOrigin(window.location.search);const receive=(e:MessageEvent)=>{if(origin&&e.origin===origin&&e.source===window.parent&&e.data?.type==="signalglass-doppler-attached"&&e.data.jobId===jobId)setAttachNote("Results attached to the case.");};window.addEventListener("message",receive);return()=>window.removeEventListener("message",receive);},[jobId]);
  const hints=useMemo(()=>new Set(countries.filter(c=>job?.language?.name&&c.languages.some(l=>l.toLowerCase()===job.language!.name!.toLowerCase()||job.language!.code==="zh"&&l==="Chinese")).map(c=>c.code)),[countries,job?.language]);
  const matches=useMemo(()=>{const term=query.trim().toLowerCase();return term?countries.filter(c=>`${c.name} ${c.code} ${c.region} ${c.subregion}`.toLowerCase().includes(term)).sort((a,b)=>Number(hints.has(b.code))-Number(hints.has(a.code))||a.name.localeCompare(b.name)).slice(0,30):[];},[countries,query,hints]);
  const input=useMemo(()=>({countries:selected,bounds,recordingStart:range,automatic:true}),[selected,bounds,range]);
  const settingsKey=JSON.stringify([jobId,input]);
  const checks=readinessSteps(job,selected,range,health,pending);
  const ready=checks.every(step=>step.ready)&&job?.state!=='cancelled'&&job?.state!=='error';
  const estimate=settingsKey===estimateKey?job?.estimate:undefined;
  useEffect(()=>{
    if(!ready||working||planned.current===settingsKey)return;
    const timer=setTimeout(()=>{planned.current=settingsKey;setEstimateKey(settingsKey);void fetch(`/api/doppler?job=${jobId}&action=estimate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}).then(json).then(accept).catch(e=>setError(e.message));},800);
    return()=>clearTimeout(timer);
  },[ready,working,settingsKey,jobId,input,accept]);
  async function segment(value:DopplerSegment){if(!job)return;setPending(true);setError("");setEstimateKey("");planned.current="";try{remember(await json(await fetch(`/api/doppler?job=${job.id}&action=segment`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)})));}catch(e){setError(e instanceof Error?e.message:"Unable to analyze portion");}finally{setPending(false);}}
  async function go(){if(!job||!ready)return;setPending(true);setError("");setChosen(null);try{accept(await json(await fetch(`/api/doppler?job=${job.id}&action=search`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)})));}catch(e){setError(e instanceof Error?e.message:"Search failed");}finally{setPending(false);}}
  async function cancel(){if(uploadRequest.current){uploadRequest.current.abort();return;}if(job)try{accept(await json(await fetch(`/api/doppler?job=${job.id}&action=cancel`,{method:'POST'})));}catch(e){setError(e instanceof Error?e.message:'Unable to cancel');}}
  const toggle=(code:string)=>{if(searching)return;setSelected(value=>value.includes(code)?value.filter(c=>c!==code):[...value,code]);};
  const leaders=useMemo(()=>{if(job?.result?.leaderboard)return job.result.leaderboard;const rows=job?.result?.flightLeaders?.length?job.result.flightLeaders:job?.result?.candidates||[];return rows.slice(0,10);},[job?.result]);
  const {places,available:placesAvailable}=useDopplerPlaces(leaders,chosen);
  const locationName=(candidate:DopplerCandidate)=>{const key=placeKey(candidate),place=places[key];return place?`${place.approximate?'Near ':''}${place.label}`:countries.find(country=>country.code===candidate.country)?.name||(Object.hasOwn(places,key)||!placesAvailable?'Location unavailable':'Locating place…');};
  function attach(){if(!job?.result)return;const report={jobId:job.id,title:job.name,sourceUrl:job.sourceUrl,mediaSha256:job.sha256,mediaSha256Scope:job.sha256Scope,segment:job.segment,analyzedAt:new Date().toISOString(),result:{...job.result,candidates:job.result.candidates.slice(0,20),flightLeaders:leaders}};const origin=embeddingOrigin(window.location.search);if(origin&&window.parent!==window){window.parent.postMessage({type:"signalglass-doppler-result",caseKey:new URLSearchParams(window.location.search).get("case"),report},origin);setAttachNote("Sending results to the case…");}else{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download=`dopplercrack-${job.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
  return <div className="dc-app">
    <div className="dc-classification"><b>TOP SECRET</b><span>FVEY // SIGINT</span><b>TOP SECRET</b></div>
    <header className="dc-header"><a href="/" className="dc-brand"><div className="dc-mark"><Radio size={22}/></div><div>DOPPLERCRACK<small>FVEY//SIGINT</small></div></a><div className="dc-status"><i className={health?.available?"online":""}/>{health?.available?"ENGINE ONLINE":"CONNECTING"}<span>LOCAL COMPUTE</span><button className="dc-cache-toggle" onClick={()=>setCacheOpen(true)}><Database size={13}/> Archive cache</button></div></header>
    <main className="dc-main">
      <div className="dc-launch"><DopplerReadiness steps={checks}/><div className="dc-launch-action">
        <DopplerLaunchSwitch disabled={!ready} busy={working} searching={!!searching} activate={()=>void go()}/>
      </div></div>
      <div className="dc-layout"><aside className="dc-sidebar"><section className="dc-panel"><h2><span>01</span> Recording <FileVideo size={16}/></h2>
        <input ref={upload} type="file" hidden accept={DOPPLER_MEDIA_ACCEPT} onChange={e=>{const file=e.target.files?.[0];if(file)void loadMedia(file);e.target.value="";}}/>
        <button className="dc-upload" disabled={working} onClick={()=>upload.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(!working&&file)void loadMedia(file);}}><Upload size={21}/><strong>{job?"Replace recording":"Upload audio or video"}</strong><small>Drop a file or browse · no file-size limit</small></button>
        <form className="dc-url" onSubmit={e=>{e.preventDefault();void loadMedia(undefined,source);}}><input aria-label="YouTube link" type="url" value={source} onChange={e=>setSource(e.target.value)} placeholder="Or paste a YouTube link…"/><button aria-label="Load YouTube details" disabled={working||!source}><ArrowUpRight size={17}/></button></form>
        {job&&<div className="dc-file"><FileVideo size={15}/><div><strong>{job.name}</strong>{job.segment&&<small>{mediaTime(job.segment.start)}–{mediaTime(job.segment.actualEnd??job.segment.end)} selected</small>}</div></div>}
        {job?.media&&(job.state==="selecting"?<DopplerClipSelector key={job.id} job={job} disabled={working} analyze={value=>void segment(value)}/>:<details className="dc-clip-details"><summary>Change recording portion <ChevronRight size={14}/></summary><DopplerClipSelector key={job.id} job={job} disabled={working} analyze={value=>void segment(value)}/></details>)}
        <div className="dc-language"><AudioLines size={17}/><div><small>SPOKEN LANGUAGE</small><strong>{job?.language?.name||(job&&!job.language&&preparing?"Detecting…":"Not detected")}</strong><p>{job?.language?.name?"Matching countries are highlighted on the map.":job?.language?"No clear speech found. Choose countries manually.":"Detected automatically when you add a recording."}</p></div></div>
        {job?.state==="ready"&&job.detectorVersion===4&&!job.events?.length&&<p className="dc-notice">No coherent moving tone found. Try another portion or a longer recording.</p>}
      </section><section className="dc-panel dc-recording-start"><h2><span>03</span> Recording start</h2><DopplerTimeControls range={range} setRange={value=>{setError("");setRange(value);}} metadata={job?.sourceRecordingTime} offset={job?.segment?.start||0} disabled={searching}/>
        {estimate&&<div className="dc-estimate" aria-label="Search estimate"><strong>{estimate.plan.clockTrials.toLocaleString()} possible start{estimate.plan.clockTrials===1?'':'s'}</strong><span>{estimate.plan.archiveDays.length} archive day{estimate.plan.archiveDays.length===1?'':'s'} · {estimate.missingArchiveDays.length} to download</span>{estimate.calibration&&<p>Estimated {formatDopplerDuration(estimate.calibration.lowerSeconds)}–{formatDopplerDuration(estimate.calibration.upperSeconds)}</p>}{estimate.plan.clockTrials>10801&&<p>Wider time and date ranges can take much longer.</p>}</div>}
      </section>
      </aside>
      <div className={`dc-workspace ${job?.result?'has-results':''}`}><section className="dc-panel dc-geography"><h2><span>02</span> Search area <Globe2 size={16}/><small>{selected.length} selected</small></h2>
        <div className="dc-geography-tools"><label className="dc-country-input"><Search size={15}/><input aria-label="Search countries" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search countries or regions" disabled={searching}/></label><select aria-label="Add a region" value="" disabled={searching} onChange={e=>setSelected(value=>[...new Set([...value,...countries.filter(c=>c.region===e.target.value||c.subregion===e.target.value).map(c=>c.code)])])}><option value="">Add region</option>{[...new Set(countries.flatMap(c=>[c.region,c.subregion]))].filter(Boolean).sort().map(r=><option key={r}>{r}</option>)}</select></div>
        {!!query.trim()&&!!matches.length&&<div className="dc-country-options">{matches.map(c=><button disabled={searching} key={c.code} className={`${selected.includes(c.code)?"selected":""} ${hints.has(c.code)?"hint":""}`} onClick={()=>toggle(c.code)}>{selected.includes(c.code)&&<Check size={12}/>} {c.name}</button>)}</div>}
        {!!hints.size&&<div className="dc-hint"><AudioLines size={13}/>{hints.size} countries share {job?.language?.name}. Language is a suggestion.<button disabled={searching} onClick={()=>setSelected(value=>[...new Set([...value,...hints])])}>Select suggested</button></div>}
        <DopplerMap countries={countries} selected={selected} hints={hints} toggle={toggle} candidates={job?.result?.candidates} choose={setChosen} focus={chosen||undefined} bounds={bounds} setBounds={value=>{if(!searching)setBounds(value);}}/>
        {(!!selected.length||bounds)&&<div className="dc-selected">{selected.map(code=><button disabled={searching} key={code} onClick={()=>toggle(code)}>{countries.find(c=>c.code===code)?.name||code}<X size={12}/></button>)}{bounds&&<button disabled={searching} onClick={()=>setBounds(undefined)}>Drawn region<X size={12}/></button>}<button className="dc-clear" disabled={searching} onClick={()=>{setSelected([]);setBounds(undefined);}}>Clear</button></div>}
        {!!selected.length&&!job?.result&&<p className="dc-coverage-note">Public flight coverage varies. Missing aircraft or unavailable archive days are reported with the results.</p>}
      </section>
      {(working||job?.state==="cancelled")&&<section className="dc-progress" aria-live="polite"><div><Radio size={16}/><strong>{pending?"Loading recording…":job?.stage}</strong><span>{Math.round(pending?uploadProgress:job?.progress||0)}%</span></div><progress max="100" value={pending?uploadProgress:job?.progress||0}/><footer><span>{searching&&job?.remainingSeconds?`About ${formatDopplerDuration(job.remainingSeconds)} remaining`:searching?"Downloading and searching the selected hours on each day…":"Processing locally"}</span>{working&&(job||uploadRequest.current)&&<button onClick={()=>void cancel()}>Cancel</button>}</footer></section>}
      {(error||job?.error)&&<div role="alert" className="dc-error">{error||job?.error}</div>}
      {job?.spectrumReady&&<DopplerSpectrum key={job.id} job={job}/>}
      <section className="dc-panel dc-results"><h2><span>04</span> Possible acoustic matches <Crosshair size={16}/>{job?.result&&<button className="dc-export" onClick={attach}><Download size={14}/> Export / attach</button>}</h2>
        {!job?.result?<div className="dc-empty"><Crosshair size={26}/><div><strong>{searching?"Searching for matches…":"Your results will appear here."}</strong><p>Explore the heatmap and the ten strongest flight matches.</p></div></div>:<>
          <div className="dc-results-summary"><span>{job.result.cellsEvaluated.toLocaleString()} locations evaluated</span><span>{leaders.length} ranked matches</span></div>
          {leaders.length?<><div className="dc-table-heading"><span>RANK</span><span>CITY / STATE / COUNTRY</span><span>{job.result.scoreMode==="spectral"?"BRIGHTNESS":"SCORE"}</span></div><ol className="dc-leaderboard">{leaders.map((candidate,i)=><li key={`${candidate.lat}:${candidate.lon}:${i}`}><button className={chosen===candidate?"active":""} onClick={()=>setChosen(candidate)}><b>{String(i+1).padStart(2,"0")}</b><div><strong>{locationName(candidate)}</strong><span>{candidate.lat.toFixed(5)}, {candidate.lon.toFixed(5)}</span><time>{formatRecordingClock(candidate.clock,range.timeZone)} · {range.timeZone}</time></div><em>{candidate.score?.toFixed(2)??"—"}<ArrowUpRight size={14}/></em></button></li>)}</ol><p className="dc-place-credit">Nearest settlement · <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a> · coordinates mark the acoustic candidate.</p>{!placesAvailable&&<p className="dc-note">Offline place names are unavailable. Run setup to install the gazetteer.</p>}</>:<p className="dc-notice">No matching locations found in the available data.</p>}
          <p className="dc-note">{job.result.scoreMode==="spectral"?"Brightness ranks acoustic matches; it is not a location probability.":"Archived scores use the earlier method. Reanalyze the recording for the current brightness workflow."}</p>
          {!!job.result.timeSearch?.skippedBatches&&<p className="dc-notice">{job.result.timeSearch.skippedBatches} time batches had no usable flight history and remain unsearched.</p>}
          {job.result.coverage.filter(c=>c.aircraft<8).map(c=><p className="dc-notice" key={c.code}>Sparse flight data in {c.code}: {c.aircraft} aircraft available.</p>)}
          <details className="dc-run-details"><summary>Search details</summary><ul>{job.result.limitations.map(note=><li key={note}>{note}</li>)}</ul></details>
        </>}{attachNote&&<p role="status" className="dc-note">{attachNote}</p>}
      </section></div></div>
    </main><footer className="dc-footer"><span>NOFORN // ORCON</span><span>HANDLE VIA SIGINT CHANNELS</span></footer>
    {chosen&&<DopplerLocationView candidate={chosen} label={locationName(chosen)} apiKey={health?.mapsKey||""} close={()=>setChosen(null)}/>}
    {cacheOpen&&<DopplerCacheMenu timeZone={range.timeZone} close={()=>setCacheOpen(false)}/>}
  </div>;
}
