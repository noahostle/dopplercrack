import { setImmediate } from "node:timers/promises";
import { insideCountry, countryRow, inBounds, wrapLon } from "./doppler-data.mjs";

export function reviewedMeasurements(events,input,duration){
  if(!["spectral","trace"].includes(input.scoreMode||"spectral"))throw new Error("Choose spectral brightness or reviewed trace scoring");
  return events.map(event=>{
    const m=input.eventMeasurements?.find(row=>row.id===event.id);
    if(m?.reviewed!==true&&!(input.automatic&&m?.source==="automatic-profile-v4"))throw new Error(`Review event ${event.id} against the spectrogram and confirm its speed, slant distance, CPA time and tone bounds before searching`);
    const fields=["cpaSeconds","cpaTolerance","minSpeed","maxSpeed","minSlant","maxSlant","minRestHz","maxRestHz"];
    if(fields.some(key=>!Number.isFinite(m[key])))throw new Error(`Event ${event.id} has incomplete measurements`);
    if(m.cpaSeconds< -300||m.cpaSeconds>duration+300||m.cpaTolerance<0||m.cpaTolerance>240||m.minSpeed<10||m.maxSpeed>245||m.maxSpeed<m.minSpeed||m.minSlant<50||m.maxSlant>10000||m.maxSlant<m.minSlant||m.minRestHz<15||m.maxRestHz>900||m.maxRestHz<m.minRestHz||m.maxRestHz-m.minRestHz>885)throw new Error(`Event ${event.id} has invalid measurement ranges (slant <=10 km; rest-frequency sweep <=885 Hz)`);
    return {id:event.id,...Object.fromEntries(fields.map(key=>[key,m[key]])),reviewed:m.reviewed===true,...(input.automatic?{source:m.source}:{})};
  });
}
export function measurementCsv(measurements){return measurements.map(m=>[m.id,m.cpaSeconds,m.cpaTolerance,m.minSpeed,m.maxSpeed,m.minSlant,m.maxSlant,m.minRestHz,m.maxRestHz,m.flightId||""].join(",")).join("\n");}

function nearSegment(lat,lon,s,radius){
  const cos=Math.max(.025,Math.cos(lat*Math.PI/180));lon+=Math.round(((s.west+s.east)/2-lon)/360)*360;
  const ax=(s.a[3]-lon)*111320*cos,ay=(s.a[2]-lat)*111320,bx=(s.bLon-lon)*111320*cos,by=(s.b[2]-lat)*111320,dx=bx-ax,dy=by-ay;
  const u=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));return Math.hypot(ax+u*dx,ay+u*dy)<=radius;
}
// Conservative spatial bins are a broad phase only; nearSegment remains authoritative.
// Keep tile/row/column order unchanged so grid coordinates and chunk boundaries agree
// with the reference scan. Padding only adds predicate tests, never accepted cells.
function corridorBins(tile,radius){
  const size=16,buckets=Array.from({length:size*size},()=>[]),r=radius+1e-5;
  const cos=Math.max(.025,Math.cos(Math.max(Math.abs(tile.south),Math.abs(tile.south+1))*Math.PI/180));
  const marginY=r/111320,marginX=r/(111320*cos),clamp=value=>Math.max(0,Math.min(size-1,value));
  for(const segment of new Set(tile.segments)){
    const south=Math.min(segment.a[2],segment.b[2])-marginY,north=Math.max(segment.a[2],segment.b[2])+marginY;
    if(north<tile.south||south>tile.south+1)continue;
    const y0=clamp(Math.floor((south-tile.south)*size)-1),y1=clamp(Math.floor((north-tile.south)*size)+1);
    for(const shift of [-360,0,360]){
      const west=segment.west-marginX+shift,east=segment.east+marginX+shift;
      if(east<tile.west||west>tile.west+1)continue;
      const x0=clamp(Math.floor((west-tile.west)*size)-1),x1=clamp(Math.floor((east-tile.west)*size)+1);
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)buckets[y*size+x].push(segment);
    }
  }return {size,buckets};
}
function mergedIntervals(intervals){
  intervals.sort((a,b)=>a[0]-b[0]);const merged=[];
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push(interval);}
  return merged;
}
// The horizontal section of a line-segment capsule is an interval. Solve its
// endpoint circles and perpendicular strip once per latitude, instead of
// recomputing a point-to-segment distance for every lattice point.
function capsuleRow(segments,lat,tile,radius){
  const scale=111320*Math.max(.025,Math.cos(lat*Math.PI/180)),outer=[],inner=[];
  for(const s of segments){
    const dx=(s.bLon-s.a[3])*scale,dy=(s.b[2]-s.a[2])*111320,ay=(s.a[2]-lat)*111320,by=ay+dy,length2=dx*dx+dy*dy,length=Math.sqrt(length2);
    for(const [r,target]of[[radius+.0001,outer],[radius-.0001,inner]]){
      let low=Infinity,high=-Infinity;
      if(Math.abs(ay)<=r){const d=Math.sqrt(Math.max(0,r*r-ay*ay));low=-d;high=d;}
      if(Math.abs(by)<=r){const d=Math.sqrt(Math.max(0,r*r-by*by));low=Math.min(low,dx-d);high=Math.max(high,dx+d);}
      if(length2){
        let a=-Infinity,b=Infinity;
        if(dy){const x=(-r*length-ay*dx)/dy,y=(r*length-ay*dx)/dy;a=Math.min(x,y);b=Math.max(x,y);}
        else if(Math.abs(ay)>r){a=Infinity;b=-Infinity;}
        if(dx){const x=ay*dy/dx,y=(length2+ay*dy)/dx;a=Math.max(a,Math.min(x,y));b=Math.min(b,Math.max(x,y));}
        else if(-ay*dy<0||-ay*dy>length2){a=Infinity;b=-Infinity;}
        if(a<=b){low=Math.min(low,a);high=Math.max(high,b);}
      }
      if(low>high)continue;
      for(const shift of[-360,0,360]){
        const west=Math.max(tile.west,s.a[3]+low/scale+shift),east=Math.min(tile.west+1,s.a[3]+high/scale+shift);
        if(west<=east)target.push([west,east]);
      }
    }
  }return {outer:mergedIntervals(outer),inner:mergedIntervals(inner)};
}
// Tile the full eligible corridor; yield bounded chunks. Never widen the requested grid.
export async function* candidateGridBatches(rows,settings,measurement,{batchSize=12000,signal,maxCells=5_000_000,reference=false}={}){
  const tiles=new Map(),radius=Math.min(10000,measurement.maxSlant)+Math.SQRT2*100;
  for(let i=1;i<rows.length;i++){
    const a=rows[i-1],b=rows[i],dt=b[1]-a[1];if(a[0]!==b[0]||dt<=0||dt>30)continue;
    const timingPadding=142/measurement.minSpeed+142/settings.soundSpeed;
    if(a[1]>settings.end+measurement.cpaSeconds+measurement.cpaTolerance+timingPadding||b[1]<settings.start+measurement.cpaSeconds-measurement.cpaTolerance-radius/settings.soundSpeed-timingPadding)continue;
    const bLon=a[3]+wrapLon(b[3]-a[3]),cos=Math.max(.025,Math.cos((a[2]+b[2])*Math.PI/360));
    const speed=Math.hypot((bLon-a[3])*111320*cos,(b[2]-a[2])*111320,b[4]-a[4])/dt;
    // The exact ECEF speed/CPA tests run in C; a 2% margin avoids projection rejection here.
    if(speed<measurement.minSpeed*.98||speed>measurement.maxSpeed*1.02)continue;
    const marginY=radius/110000,marginX=marginY/Math.max(.025,Math.cos(Math.max(Math.abs(a[2]),Math.abs(b[2]))*Math.PI/180));
    const segment={a,b,bLon,west:Math.min(a[3],bLon),east:Math.max(a[3],bLon)};
    for(let y=Math.max(-90,Math.floor(Math.min(a[2],b[2])-marginY));y<=Math.min(89,Math.floor(Math.max(a[2],b[2])+marginY));y++){
      for(let x=Math.floor(segment.west-marginX);x<=Math.floor(segment.east+marginX);x++){
        const tileX=wrapLon(x),key=`${y}:${tileX}`;if(!tiles.has(key))tiles.set(key,{south:y,west:tileX,segments:[]});tiles.get(key).segments.push(segment);
      }
    }
  }
  const dy=.2/111.32;let cells=[],count=0,visited=0,rowVisits=0;
  for(const tile of [...tiles.values()].sort((a,b)=>a.south-b.south||a.west-b.west)){
    const bins=reference?null:corridorBins(tile,radius);
    const segmentRows=bins?Array.from({length:bins.size},(_,y)=>[...new Set(bins.buckets.slice(y*bins.size,(y+1)*bins.size).flat())]):null;
    const ymin=Math.ceil(tile.south/dy),ymax=Math.ceil((tile.south+1)/dy);
    for(let y=ymin;y<ymax;y++){
      if(++rowVisits%256===0){if(signal?.aborted)throw new Error("Job cancelled");await setImmediate();}
      const lat=y*dy,dx=.2/(111.32*Math.max(.025,Math.cos(lat*Math.PI/180))),xmin=Math.ceil(tile.west/dx),xmax=Math.ceil((tile.west+1)/dx);
      const selectors=reference?null:settings.selected.map(country=>({country,test:countryRow(lat,country)}));
      const binY=bins?Math.max(0,Math.min(bins.size-1,Math.floor((lat-tile.south)*bins.size))):0;
      const segments=reference?tile.segments:segmentRows[binY],capsules=reference?null:capsuleRow(segments,lat,tile,radius);
      const spans=reference?[[xmin,xmax-1]]:mergedIntervals(capsules.outer.map(([west,east])=>[Math.max(xmin,Math.ceil(west/dx)-1),Math.min(xmax-1,Math.floor(east/dx)+1)]));
      let innerIndex=0;
      for(const [begin,end]of spans)for(let x=begin;x<=end;x++){
        if(++visited%8192===0){if(signal?.aborted)throw new Error("Job cancelled");await setImmediate();}
        const lon=x*dx;if(!inBounds(lon,lat,settings.bounds))continue;
        if(capsules)while(innerIndex<capsules.inner.length&&capsules.inner[innerIndex][1]<lon)innerIndex++;
        const certified=capsules&&innerIndex<capsules.inner.length&&capsules.inner[innerIndex][0]<=lon&&lon<=capsules.inner[innerIndex][1];
        if(!certified&&!segments.some(s=>nearSegment(lat,lon,s,radius)))continue;
        const country=reference?settings.selected.find(c=>insideCountry(lon,lat,c)):selectors.find(c=>c.test(lon))?.country;if(!country)continue;
        if(++count>maxCells)throw new Error("200 m grid exceeds five million cells in this clock batch; narrow the region or time. Resolution was not silently reduced.");
        cells.push([lat,lon,settings.altitude,country.code]);if(cells.length===batchSize){yield cells;cells=[];}
      }
    }
  }if(cells.length)yield cells;
}
export function refinedGrid(survivors,settings){
  const seen=new Set(),cells=[],dy=.1/111.32;
  for(const center of survivors)for(let y=-1;y<=1;y++){
    const lat=center.lat+y*dy,dx=.1/(111.32*Math.max(.025,Math.cos(lat*Math.PI/180)));
    const selectors=settings.selected.map(country=>({country,test:countryRow(lat,country)}));
    for(let x=-1;x<=1;x++){
      const lon=wrapLon(Math.round(center.lon/dx)*dx+x*dx),key=`${lat.toFixed(7)}:${lon.toFixed(7)}`;if(seen.has(key))continue;seen.add(key);
      if(!inBounds(lon,lat,settings.bounds))continue;const country=selectors.find(c=>c.test(lon))?.country;if(country)cells.push([lat,lon,settings.altitude,country.code]);
    }
  }return cells;
}
export function rankValue(candidate){return candidate.rankLoss??candidate.loss;}
export function flightLeaders(candidates){const seen=new Set();return [...candidates].sort((a,b)=>rankValue(a)-rankValue(b)).filter(c=>{const key=`${c.flights.join("|")}:${Math.floor(c.clock/86400)}`;if(seen.has(key))return false;seen.add(key);if(seen.size>100000)throw new Error("Flight-combination budget exceeded across clock batches; narrow the date range or event measurements");return true;});}
export function polishGrid(center,settings,spacingM=25,radiusM=500){
  const cells=[],dy=spacingM/111320,low=Math.ceil((center.lat-radiusM/111320)/dy),high=Math.floor((center.lat+radiusM/111320)/dy);
  for(let y=low;y<=high;y++){
    const lat=y*dy,cos=Math.max(.025,Math.cos(lat*Math.PI/180)),dx=spacingM/(111320*cos),west=Math.ceil((center.lon-radiusM/(111320*cos))/dx),east=Math.floor((center.lon+radiusM/(111320*cos))/dx);
    for(let x=west;x<=east;x++){const lon=wrapLon(x*dx);if(Math.hypot((lat-center.lat)*111320,wrapLon(lon-center.lon)*111320*cos)>radiusM||!inBounds(lon,lat,settings.bounds))continue;const country=settings.selected.find(c=>insideCountry(lon,lat,c));if(country)cells.push([lat,lon,settings.altitude,country.code]);}
  }return cells;
}
