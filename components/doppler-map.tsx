"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Globe2, Minus, Plus, Scan } from "lucide-react";
import type { DopplerCandidate, DopplerCountry, DopplerRegion } from "../lib/doppler-types";

const project = (lon: number, lat: number) => [lon + 180, 90 - lat];
export function DopplerMap({ countries, selected, hints, toggle, candidates = [], choose, bounds, setBounds, focus }: {
  countries: DopplerCountry[]; selected: string[]; hints: Set<string>; toggle: (code: string) => void;
  candidates?: DopplerCandidate[]; choose: (candidate: DopplerCandidate) => void; bounds?: DopplerRegion; setBounds: (bounds?: DopplerRegion) => void;
  focus?:DopplerCandidate;
}) {
  const [view, setView] = useState([0, 5, 360, 166]);
  const [hover, setHover] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<number[] | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const suppressClick = useRef(false);
  const paths = useMemo(() => countries.map(country => ({ country, d: country.polygons.map(polygon => polygon.map(ring => ring.map((point, i) => `${i ? "L" : "M"}${project(point[0], point[1]).join(",")}`).join("") + "Z").join("")).join("") })), [countries]);
  function fit() {
    const rows = candidates.length ? candidates.map(row => [row.lon, row.lat]) : countries.filter(country => selected.includes(country.code)).flatMap(country => country.polygons.length ? country.polygons.flatMap(polygon => polygon[0]) : [[country.center[1], country.center[0]]]);
    if (!rows.length) { setView([0,5,360,166]); return; }
    const [x,y,right,bottom] = rows.reduce((box,row)=>[Math.min(box[0],row[0]+180),Math.min(box[1],90-row[1]),Math.max(box[2],row[0]+180),Math.max(box[3],90-row[1])],[360,180,0,0]);
    const width = Math.max(.015,right-x), height = Math.max(.01,bottom-y);
    setView([x - width*.1, y - height*.1, width*1.2, height*1.2]);
  }
  function zoom(factor: number) { setView(([x,y,w,h]) => { const nw = Math.min(360,Math.max(.003,w*factor)), nh = Math.min(180,Math.max(.002,h*factor)); return [x+(w-nw)/2,y+(h-nh)/2,nw,nh]; }); }
  const resultLocation=candidates.length?`${candidates[0].lat}:${candidates[0].lon}:${candidates.length}`:"";
  useEffect(()=>{if(focus)setView([focus.lon+180-.025,90-focus.lat-.016,.05,.032]);},[focus]);
  useEffect(()=>{
    if(!resultLocation)return;const frame=requestAnimationFrame(fit);return()=>cancelAnimationFrame(frame);
  // Fit newly returned results once; country selection has its own fit control.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[resultLocation]);
  function point(clientX: number, clientY: number) {
    if (!svg.current) return [0,0];
    const p = svg.current.createSVGPoint(); p.x = clientX; p.y = clientY;
    const matrix = svg.current.getScreenCTM()?.inverse(); const transformed = matrix ? p.matrixTransform(matrix) : p;
    return [Math.max(-180,Math.min(180,transformed.x-180)), Math.max(-90,Math.min(90,90-transformed.y))];
  }
  const scale = view[2]/360;
  return <div className="doppler-map-shell"><div className="doppler-map-toolbar"><div><Globe2 size={14}/><strong>{hover || (candidates.length?"ACOUSTIC FIT / LOCAL GRID":"WORLD SEARCH AREA")}</strong><span>{selected.length} selected</span></div><div>
    <button type="button" onClick={()=>setView([0,5,360,166])} title="World view"><Globe2 size={15}/></button><button type="button" onClick={fit} title="Fit selection or results"><Crosshair size={15}/></button>
    <button type="button" onClick={()=>zoom(.6)} title="Zoom in"><Plus size={15}/></button><button type="button" onClick={()=>zoom(1.6)} title="Zoom out"><Minus size={15}/></button>
    <button type="button" className={drawing ? "active" : ""} onClick={()=>setDrawing(!drawing)}><Scan size={14}/> Draw region</button></div></div>
    <svg ref={svg} viewBox={view.join(" ")} className={`doppler-world ${drawing?"drawing":""} ${candidates.length?"results":""}`} role="img" aria-label="Interactive world map: select countries; use Draw region to narrow the search" onPointerDown={event=>{ if(!drawing)return; suppressClick.current=true; const p=point(event.clientX,event.clientY);setDrag([...p,...p]);event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event=>{ if(drawing&&drag){const p=point(event.clientX,event.clientY);setDrag([drag[0],drag[1],...p]);} }} onPointerUp={()=>{if(drag){const [a,b,c,d]=drag;if(Math.abs(a-c)>.0001&&Math.abs(b-d)>.0001)setBounds({west:Math.min(a,c),east:Math.max(a,c),south:Math.min(b,d),north:Math.max(b,d)});setDrag(null);setDrawing(false);requestAnimationFrame(()=>{suppressClick.current=false;});}}}>
      <defs><pattern id="doppler-grid" width="15" height="15" patternUnits="userSpaceOnUse"><path d="M15 0H0V15" fill="none" stroke="#bfcab3" strokeWidth=".18"/></pattern><radialGradient id="doppler-heat"><stop stopColor="#a82d1d" stopOpacity=".95"/><stop offset=".4" stopColor="#ce6232" stopOpacity=".6"/><stop offset="1" stopColor="#e79d63" stopOpacity="0"/></radialGradient></defs>
      <rect width="360" height="180" fill="#e8eee0"/><rect width="360" height="180" fill="url(#doppler-grid)"/>
      {paths.map(({country,d})=><path key={country.code} d={d} fillRule="evenodd" className={`doppler-country ${selected.includes(country.code)?"selected":""} ${hints.has(country.code)?"language-hint":""}`} strokeWidth={Math.max(.025,.24*scale)} onMouseEnter={()=>setHover(country.name)} onMouseLeave={()=>setHover("")} onClick={()=>{if(!drawing&&!suppressClick.current)toggle(country.code);}}><title>{country.name}{hints.has(country.code)?" · speech-language hint":""}</title></path>)}
      {countries.filter(country=>!country.polygons.length).map(country=><circle key={country.code} cx={country.center[1]+180} cy={90-country.center[0]} r={Math.max(.2,.8*scale)} className={`doppler-country ${selected.includes(country.code)?"selected":""} ${hints.has(country.code)?"language-hint":""}`} onClick={()=>{if(!drawing&&!suppressClick.current)toggle(country.code);}}><title>{country.name}</title></circle>)}
      {!!candidates.length&&[1,2,3,4].map(i=><g key={i} className="doppler-fit-grid"><line x1={view[0]+view[2]*i/5} y1={view[1]} x2={view[0]+view[2]*i/5} y2={view[1]+view[3]}/><line x1={view[0]} y1={view[1]+view[3]*i/5} x2={view[0]+view[2]} y2={view[1]+view[3]*i/5}/><text x={view[0]+view[2]*i/5} y={view[1]+view[3]*.07} fontSize={view[2]*.01}>{(view[0]+view[2]*i/5-180).toFixed(3)}°</text></g>)}
      {candidates.slice().reverse().map((candidate,i)=><circle key={`${candidate.lat}:${candidate.lon}:${i}`} cx={candidate.lon+180} cy={90-candidate.lat} r={Math.max(.0002,Math.min(5*scale,.07))} fill="url(#doppler-heat)" opacity={.2+.8*(candidate.relativeFit||0)} onClick={()=>{if(!drawing&&!suppressClick.current)choose(candidate);}} className="doppler-heat-cell"><title>{candidate.lat.toFixed(5)}, {candidate.lon.toFixed(5)} · brightness {candidate.score?.toFixed(2)}</title></circle>)}
      {focus&&<g className="dc-map-pin" transform={`translate(${focus.lon+180},${90-focus.lat})`}><circle r={view[2]*.012} fill="none" stroke="#692b21" strokeWidth={view[2]*.002}/><circle r={view[2]*.003} fill="#962d20"/></g>}
      {bounds&&(bounds.east>=bounds.west?[bounds]:[{...bounds,east:180},{...bounds,west:-180}]).map((part,index)=><rect key={index} x={part.west+180} y={90-part.north} width={part.east-part.west} height={part.north-part.south} className="doppler-region"/>)}
      {drag&&<rect x={180+Math.min(drag[0],drag[2])} y={90-Math.max(drag[1],drag[3])} width={Math.abs(drag[2]-drag[0])} height={Math.abs(drag[3]-drag[1])} className="doppler-region" strokeWidth={.4*scale}/>}
    </svg><div className="doppler-map-legend"><span><i className="selected"/> Selected area</span><span><i className="language-hint"/> Speech-language hint</span><span><i className="heat"/> Relative acoustic fit</span><small>Approximate Natural Earth boundaries · country names and languages: CC0</small></div>
  </div>;
}
