"use client";
import type { DopplerRecordingTime } from "../lib/doppler-types";
export type DopplerTimeRange = { mode:"exact"|"range"; dateFrom:string; dateTo:string; timeFrom:string; timeTo:string; timeZone:string; stepSeconds:number };
export const emptyDopplerTimeRange:DopplerTimeRange={mode:"exact",dateFrom:"",dateTo:"",timeFrom:"",timeTo:"",timeZone:"UTC",stepSeconds:1};
export function formatDopplerDuration(seconds:number){
  if(seconds<60)return `${Math.max(1,Math.ceil(seconds))} sec`;
  if(seconds<3600)return `${Math.ceil(seconds/60)} min`;
  if(seconds<86400)return `${(seconds/3600).toFixed(1)} hr`;
  return `${(seconds/86400).toFixed(1)} days`;
}
const zones=["UTC",...Intl.supportedValuesOf("timeZone")];
export function DopplerTimeControls({range,setRange,metadata,disabled=false,offset=0}:{range:DopplerTimeRange;setRange:(value:DopplerTimeRange)=>void;metadata?:DopplerRecordingTime;disabled?:boolean;offset?:number}){
  const expanded=range.mode==='range';
  return <fieldset className="dc-time" disabled={disabled}>
    <legend>When did the original recording start?</legend>
    <label>Recording timezone<select aria-label="Recording timezone" value={range.timeZone} onChange={e=>setRange({...range,timeZone:e.target.value})}>{[...new Set([range.timeZone,...zones])].map(zone=><option key={zone} value={zone}>{zone.replaceAll("_"," ")}</option>)}</select></label>
    <label className="dc-range-toggle"><input type="checkbox" role="switch" checked={expanded} onChange={e=>setRange({...range,mode:e.target.checked?'range':'exact',dateTo:range.dateTo||range.dateFrom,timeTo:range.timeTo||range.timeFrom})}/><span>Search a start-time range</span></label>
    <div className="dc-field-pair"><label>{expanded?'First date':'Start date'}<input aria-label="Start date" type="date" value={range.dateFrom} onChange={e=>setRange({...range,dateFrom:e.target.value,dateTo:range.dateTo||e.target.value})}/></label><label>{expanded?'Earliest start time':'Start time'}<input aria-label="Start time" type="time" step="1" value={range.timeFrom} onChange={e=>setRange({...range,timeFrom:e.target.value})}/></label></div>
    <div className={`dc-range-reveal ${expanded?'is-open':''}`} aria-hidden={!expanded}><div><fieldset disabled={disabled||!expanded}>
      <div className="dc-field-pair"><label>Last date<input aria-label="Last date" type="date" min={range.dateFrom} value={range.dateTo} onChange={e=>setRange({...range,dateTo:e.target.value})}/></label><label>Latest start time<input aria-label="Latest start time" type="time" step="1" value={range.timeTo} onChange={e=>setRange({...range,timeTo:e.target.value})}/></label></div>
      <label>Try a start every<select aria-label="Start-time interval" value={range.stepSeconds} onChange={e=>setRange({...range,stepSeconds:Number(e.target.value)})}>{[1,2,5,10,30,60].map(n=><option key={n} value={n}>{n} second{n===1?'':'s'}</option>)}</select></label>
      <p className="dc-note">These are possible <strong>start times</strong>, repeated on each selected day. {range.timeTo<range.timeFrom?'The window crosses midnight. ':''}Larger intervals search faster but can miss a match.</p>
    </fieldset></div></div>
    <p className="dc-note">{expanded?'Every trial aligns the entire selected portion to a possible recording start.':'One date and time for the start of the original recording.'}{offset>0?` The selected portion begins ${offset} seconds later; this offset is applied automatically.`:''}</p>
    {(metadata?.utc||metadata?.local||metadata?.date)&&<p className="dc-metadata">Embedded recording time detected. Check the original start time is correct.</p>}
  </fieldset>;
}
