"use client";
import { useEffect, useRef, useState } from "react";
import type { DopplerCandidate } from "../lib/doppler-types";
type MapInstance = { setStreetView: (panorama: unknown) => void };
type MapsApi = { Map: new (element: HTMLElement, options: object) => MapInstance; StreetViewPanorama: new (element: HTMLElement, options: object) => unknown;
  StreetViewService: new () => { getPanorama: (options: object, callback: (data: { location?: { pano?: string } } | null, status: string) => void) => void } };
declare global { interface Window { google?: { maps: MapsApi } } }
let loading: Promise<MapsApi> | undefined;
function maps(key: string) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  loading ||= new Promise<MapsApi>((resolve,reject)=>{
    const script = document.createElement("script"); script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    script.async=true; script.onload=()=>window.google?.maps?resolve(window.google.maps):reject(new Error("Maps API did not load"));script.onerror=()=>{loading=undefined;reject(new Error("Maps API failed"));};document.head.appendChild(script);
  });return loading;
}
export function DopplerLocationView({ candidate, label, apiKey, close }: { candidate: DopplerCandidate; label:string; apiKey: string; close: () => void }) {
  const element=useRef<HTMLDivElement>(null);const [status,setStatus]=useState("Checking Street View imagery…");
  useEffect(()=>{
    let active=true;if(!apiKey)return;setStatus("Checking Street View imagery…");
    void maps(apiKey).then(api=>{
      if(!active||!element.current)return;
      const location={lat:candidate.lat,lng:candidate.lon};
      const map=new api.Map(element.current,{center:location,zoom:18,mapTypeId:"satellite",streetViewControl:true});
      new api.StreetViewService().getPanorama({location,radius:100},(data,state)=>{
        if(!active||!element.current)return;
        if(state==="OK"&&data?.location?.pano){const panorama=new api.StreetViewPanorama(element.current,{pano:data.location.pano,visible:true});map.setStreetView(panorama);setStatus("Nearby Street View panorama (within 100 m of this candidate)");}
        else setStatus("No Street View imagery returned here. Showing zoomed satellite imagery.");
      });
    }).catch(()=>{if(active)setStatus("Maps could not load. Open the satellite or Street View links below.");});
    return()=>{active=false;};
  },[apiKey,candidate]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const dialog=document.querySelector<HTMLElement>(".doppler-location-modal");
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape")close();if(event.key==="Tab"&&dialog){const elements=[...dialog.querySelectorAll<HTMLElement>('button,a[href],iframe')];const first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();document.addEventListener("keydown",key);const overflow=document.body.style.overflow;document.body.style.overflow="hidden";
    return()=>{document.removeEventListener("keydown",key);document.body.style.overflow=overflow;previous?.focus();};
  },[close]);
  const position=`${candidate.lat},${candidate.lon}`;
  return <div className="doppler-modal-backdrop" onMouseDown={close}><section className="doppler-location-modal" role="dialog" aria-modal="true" aria-label="Review candidate location" onMouseDown={event=>event.stopPropagation()}><div className="doppler-panel-heading"><div><span>POSSIBLE ACOUSTIC MATCH</span><h2>{label}</h2><p>{candidate.lat.toFixed(6)}, {candidate.lon.toFixed(6)}</p></div><button type="button" onClick={close}>Close</button></div>
    {apiKey?<><p>{status}</p><div className="doppler-google-map" ref={element}/></>:<><p>Satellite view. You can also open nearby Street View below.</p><iframe title="Candidate satellite map" className="doppler-google-map" src={`https://maps.google.com/maps?q=${encodeURIComponent(position)}&t=k&z=18&output=embed`} referrerPolicy="strict-origin-when-cross-origin" loading="lazy"/></>}
    <div className="doppler-review-links"><a href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${position}`} target="_blank" rel="noreferrer">Open Google Street View</a><a href={`https://www.google.com/maps/@?api=1&map_action=map&center=${position}&zoom=18&basemap=satellite`} target="_blank" rel="noreferrer">Open satellite map</a></div><small>This is a ranked acoustic candidate. Imagery may be old or captured away from the recording point.</small>
  </section></div>;
}
