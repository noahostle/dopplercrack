import {useEffect,useRef,useState} from "react";
import {archiveLocalWindow,browserTimeZone} from "../lib/doppler-clock.mjs";
import {LoaderCircle,Trash2} from "lucide-react";
type Inventory={days:{date:string;bytes:number;files:number;complete:boolean}[];bytes:number;files:number;busy:boolean;cleared?:{bytes:number;files:number}};
const size=(bytes:number)=>bytes>=2**30?`${(bytes/2**30).toFixed(2)} GB`:bytes>=2**20?`${(bytes/2**20).toFixed(1)} MB`:`${(bytes/1024).toFixed(1)} KB`;
export function DopplerCacheMenu({close,timeZone=browserTimeZone()}:{close:()=>void;timeZone?:string}){
  const [data,setData]=useState<Inventory>(),[selected,setSelected]=useState<string[]>([]),[loading,setLoading]=useState(true),[clearing,setClearing]=useState(false),[error,setError]=useState("");
  const dialog=useRef<HTMLDivElement>(null);
  async function refresh(){setLoading(true);setError("");try{const r=await fetch("/api/doppler?action=cache"),d=await r.json();if(!r.ok)throw Error(d.error);setData(d);}catch(e){setError(e instanceof Error?e.message:"Unable to read cache");}finally{setLoading(false);}}
  useEffect(()=>{void refresh();const previous=document.activeElement as HTMLElement;dialog.current?.focus();return()=>previous?.focus();},[]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!clearing){e.preventDefault();close();}
      if(e.key!=='Tab')return;
      const items=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
      if(!items?.length){e.preventDefault();return;}
      const first=items[0],last=items[items.length-1],outside=!dialog.current?.contains(document.activeElement);
      if(e.shiftKey&&(outside||document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&(outside||document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[close,clearing]);
  async function clear(){setClearing(true);setError("");try{const r=await fetch("/api/doppler?action=clear-cache",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dates:selected})}),d=await r.json();if(!r.ok)throw Error(d.error);setData(d);setSelected([]);}catch(e){setError(e instanceof Error?e.message:"Unable to clear cache");}finally{setClearing(false);}}
  const bytes=data?.days.filter(d=>selected.includes(d.date)).reduce((sum,d)=>sum+d.bytes,0)||0;
  return <div className="doppler-modal-backdrop" onClick={e=>{if(e.target===e.currentTarget&&!clearing)close();}}><div className="doppler-location-modal dc-cache-modal" ref={dialog} role="dialog" aria-modal="true" aria-label="ADS-B archive cache" tabIndex={-1}>
    <div className="doppler-panel-heading"><div><span>LOCAL STORAGE</span><h2>ADS-B archive cache</h2></div><button onClick={close} disabled={clearing}>Close</button></div>
    {loading?<p role="status"><LoaderCircle size={14} className="spin"/> Reading archive sizes…</p>:<>
      <p>{data?.days.length||0} days · {size(data?.bytes||0)} stored</p>
      {!!data?.days.length&&<><div className="dc-cache-tools"><button disabled={clearing} onClick={()=>setSelected(data.days.map(d=>d.date))}>Select all</button><button disabled={clearing} onClick={()=>{const cutoff=new Date(Date.now()-30*86400000).toISOString().slice(0,10);setSelected(data.days.filter(d=>d.date<cutoff).map(d=>d.date));}}>Older than 30 days</button><button disabled={clearing} onClick={()=>setSelected([])}>Deselect</button><button disabled={clearing} onClick={()=>void refresh()}>Refresh</button></div><div className="dc-cache-days">{data.days.map(d=><label key={d.date}><input type="checkbox" checked={selected.includes(d.date)} disabled={clearing} onChange={()=>setSelected(value=>value.includes(d.date)?value.filter(x=>x!==d.date):[...value,d.date])}/><div className="dc-cache-day"><strong>{archiveLocalWindow(d.date,timeZone)}</strong><span>Archive {d.date} UTC{!d.complete?' · partial':''}</span></div><small>{size(d.bytes)} · {d.files.toLocaleString()} files</small></label>)}</div></>}
      {data?.busy&&<p className="dc-notice">A job is running. Refresh after it finishes to enable cleanup.</p>}
      {!!data?.cleared&&<p role="status">Cleared {data.cleared.files.toLocaleString()} files · {size(data.cleared.bytes)} freed.</p>}
      <button className="dc-cache-delete" disabled={loading||clearing||data?.busy||!selected.length} onClick={()=>void clear()}>{clearing?<LoaderCircle size={14} className="spin"/>:<Trash2 size={14}/>} {clearing?"Clearing…":`Clear ${selected.length} selected days · ${size(bytes)}`}</button>
    </>}{error&&<p className="dc-error" role="alert">{error}</p>}
  </div></div>;
}
