import { createReadStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { buildClockPlan } from "./doppler-time.mjs";

let aircraftTypes = {};
try { aircraftTypes = JSON.parse(await readFile(new URL("../runtime/reference/types.json", import.meta.url), "utf8")); } catch {}
export const aircraftTypesAvailable=Object.keys(aircraftTypes).length>2000;
export function aircraftDescription(type, description = "", lookup = aircraftTypes) {
  const value = lookup[String(type || "").toUpperCase()]?.desc || description;
  return /^[A-Z][0-9][A-Z-]$/.test(value) ? value : "";
}
export function isKnownJet(row) { return /J$/.test(row[5] || ""); }

export const dataRoot = fileURLToPath(new URL("../data/", import.meta.url));
// Small metadata index: later clock batches need not reparse unrelated global aircraft.
const traceBoundsIndex = new Map();
export function clearTrackMetadataCache(){traceBoundsIndex.clear();}
export const countries = JSON.parse(await readFile(new URL("../public/doppler/world.json", import.meta.url), "utf8"));
for (const country of countries) country.boxes = country.polygons.map(polygon => polygon[0].reduce((b, p) => [Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])], [180,90,-180,-90]));
export const wrapLon = lon => ((lon + 540) % 360) - 180;
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function insideCountry(lon, lat, country) {
  if (!country.polygons.length) return Math.hypot((lon - country.center[1]) * Math.cos(lat * Math.PI / 180), lat - country.center[0]) < .03;
  return country.polygons.some((polygon, index) => { const b = country.boxes?.[index]; return (!b || lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) && inRing(lon, lat, polygon[0]) && !polygon.slice(1).some(hole => inRing(lon, lat, hole)); });
}
// Compile the reference ray test once per grid latitude. The intersection
// expression and strict longitude comparison are identical to inRing above.
// Binary search replaces scanning every polygon edge for every receiver cell.
const countryRows=new WeakMap();
export function countryRow(lat,country){
  let cache=countryRows.get(country);if(!cache){cache=new Map();countryRows.set(country,cache);}
  if(cache.has(lat))return cache.get(lat);
  const crossing=ring=>{
    const xs=[];for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [xi,yi]=ring[i],[xj,yj]=ring[j];
      if((yi>lat)!==(yj>lat))xs.push((xj-xi)*(lat-yi)/(yj-yi)+xi);
    }return xs.sort((a,b)=>a-b);
  };
  const inCrossings=(lon,xs)=>{let low=0,high=xs.length;while(low<high){const mid=(low+high)>>>1;if(xs[mid]<=lon)low=mid+1;else high=mid;}return (xs.length-low)%2===1;};
  const polygons=country.polygons.map((polygon,index)=>({box:country.boxes?.[index],rings:polygon})).filter(p=>!p.box||lat>=p.box[1]&&lat<=p.box[3]).map(p=>({...p,rings:p.rings.map(crossing)}));
  const predicate=country.polygons.length?lon=>polygons.some(p=>(!p.box||lon>=p.box[0]&&lon<=p.box[2])&&inCrossings(lon,p.rings[0])&&!p.rings.slice(1).some(ring=>inCrossings(lon,ring))):lon=>insideCountry(lon,lat,country);
  if(cache.size>=4096)cache.delete(cache.keys().next().value);cache.set(lat,predicate);return predicate;
}
export function inBounds(lon, lat, bounds) {
  return !bounds || (lat >= bounds.south && lat <= bounds.north && (bounds.west <= bounds.east ? lon >= bounds.west && lon <= bounds.east : lon >= bounds.west || lon <= bounds.east));
}
export function validateSearch(input, duration) {
  if(input.terrainMode!==undefined&&!["auto","local","constant"].includes(input.terrainMode))throw new Error("Choose automatic, local or constant receiver terrain");
  for(const key of ["silence","online"])if(input[key]!==undefined&&typeof input[key]!=="boolean")throw new Error(`${key} must be true or false`);
  const selected = countries.filter(country => Array.isArray(input.countries) && input.countries.includes(country.code));
  if (!selected.length) throw new Error("Select at least one country or territory");
  const plan = buildClockPlan(input, duration), { start, end, timeStep } = plan;
  let allowedArchiveDays;
  if (input.allowedArchiveDays !== undefined) {
    if (!Array.isArray(input.allowedArchiveDays) || !input.allowedArchiveDays.length || input.allowedArchiveDays.length > 366 || input.allowedArchiveDays.some(day => typeof day !== "string" || !plan.archiveDays.includes(day))) throw new Error("Choose archive days required by this search window");
    allowedArchiveDays = [...new Set(input.allowedArchiveDays)];
    plan.requiredArchiveDays = plan.archiveDays; plan.archiveDays = plan.archiveDays.filter(day => allowedArchiveDays.includes(day));
  }
  let bounds;
  if (input.bounds) {
    const { west, east, south, north } = input.bounds;
    if (![west, east, south, north].every(Number.isFinite) || Math.abs(west) > 180 || Math.abs(east) > 180 || south < -90 || north > 90 || south >= north) throw new Error("Invalid region bounds");
    bounds = { west, east, south, north };
  }
  const gridKm = Number(input.gridKm ?? .2), altitude = Number(input.receiverAltitude ?? 0), temperature = Number(input.temperature ?? 15);
  if (!Number.isFinite(gridKm) || gridKm < .1 || gridKm > 100 || !Number.isFinite(altitude) || altitude < -500 || altitude > 9000 || !Number.isFinite(temperature) || temperature < -60 || temperature > 60) throw new Error("Invalid grid, receiver elevation or temperature");
  return { selected, start, end, duration, bounds, timeStep, gridKm, altitude, soundSpeed: 331.3 + .606 * temperature, plan, allowedArchiveDays,
    threads: Math.max(0, Math.min(32, Math.round(Number(input.threads) || 0))) };
}
export function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(x => x.trim().toLowerCase());
  const at = (...keys) => header.findIndex(x => keys.includes(x));
  const indices = [at("icao", "hex", "aircraft"), at("timestamp", "time", "utc"), at("lat", "latitude"), at("lon", "longitude"), at("altitude_m", "alt_m", "alt_geom_m")];
  if (indices.some(x => x < 0)) throw new Error("Tracks CSV needs icao,timestamp,lat,lon,altitude_m (metres, WGS84 ellipsoidal height)");
  return lines.slice(1).flatMap(line => {
    const fields = line.split(",").map(x => x.trim());
    const t = /^\d+(\.\d+)?$/.test(fields[indices[1]] || "") ? Number(fields[indices[1]]) : Date.parse(fields[indices[1]]) / 1000;
    const description=aircraftDescription(fields[at("icao_type", "type_code", "aircraft_type")],fields[at("icao_description")]);
    return normalizeRow([fields[indices[0]], t, Number(fields[indices[2]]), Number(fields[indices[3]]), Number(fields[indices[4]]), ...(description ? [description] : [])]);
  });
}
function normalizeRow(row) {
  const [id, t, lat, lon, altitude] = row;
  if (!/^[A-Za-z0-9_.-]{1,31}$/.test(id || "") || ![t, lat, lon, altitude].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || altitude < -500 || altitude > 30000) return [];
  return [[id, t, lat, lon, altitude, ...row.slice(5,6)]];
}
export function readsbRows(data) {
  if (Array.isArray(data.trace) && Number.isFinite(data.timestamp)) return data.trace.flatMap(point => {
    if ((point[6] & 1) || point[3] === "ground") return [];
    const feet = point[10] ?? point[8]?.alt_geom ?? ((point[6] & 8) ? point[3] : null);
    const description=aircraftDescription(data.t || point[8]?.t);
    return feet === null ? [] : normalizeRow([data.icao, data.timestamp + point[0], point[1], point[2], feet * .3048, ...(description ? [description] : [])]);
  });
  if (Array.isArray(data.aircraft)) return data.aircraft.flatMap(aircraft => aircraft.alt_geom == null ? [] : normalizeRow([aircraft.hex, data.now - (aircraft.seen_pos || 0), aircraft.lat, aircraft.lon, aircraft.alt_geom * .3048, aircraftDescription(aircraft.t)]));
  return [];
}
export function nearSelection(row, settings) {
  const [, t, lat, lon] = row;
  if (t < settings.start - 600 || t > settings.end + settings.duration + 600) return false;
  // Keep boundary-crossing aircraft just outside the selected receiver territory.
  const dlat = .5, dlon = .5 / Math.max(.05, Math.cos(lat * Math.PI / 180));
  if (settings.bounds && !inBounds(lon, lat, { west: wrapLon(settings.bounds.west - dlon), east: wrapLon(settings.bounds.east + dlon), south: settings.bounds.south - dlat, north: settings.bounds.north + dlat })) return false;
  return settings.selected.some(country => nearCountry(lon,lat,country,dlon,dlat));
}
function nearCountry(lon,lat,country,dlon=.5/Math.max(.05,Math.cos(lat*Math.PI/180)),dlat=.5) {
  const boxes=country.boxes?.length?country.boxes:[[country.center[1],country.center[0],country.center[1],country.center[0]]];
  return boxes.some(b=>lat>=b[1]-dlat&&lat<=b[3]+dlat&&(b[2]-b[0]+2*dlon>=360||inBounds(lon,lat,{west:wrapLon(b[0]-dlon),east:wrapLon(b[2]+dlon),south:b[1]-dlat,north:b[3]+dlat})));
}
export async function *trackFiles(root, depth = 0) {
  if (depth > 10) return;
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const path = join(root, item.name);
    if (item.isDirectory()) yield *trackFiles(path, depth + 1);
    else if (/\.(csv|json|json\.gz)$/i.test(item.name)) yield path;
  }
}
function traceExtent(rows) {
  if (!rows.length) return { empty: true };
  const box = { start: Infinity, end: -Infinity, south: 90, north: -90, west: 180, east: -180 };
  for (const row of rows) { box.start=Math.min(box.start,row[1]);box.end=Math.max(box.end,row[1]);box.south=Math.min(box.south,row[2]);box.north=Math.max(box.north,row[2]);box.west=Math.min(box.west,row[3]);box.east=Math.max(box.east,row[3]); }
  return box;
}
function extentMayMatch(box, settings) {
  if (box.empty || box.end < settings.start - 600 || box.start > settings.end + settings.duration + 600) return false;
  const dlon=.5/Math.max(.05,Math.cos(Math.max(Math.abs(box.south),Math.abs(box.north))*Math.PI/180));
  return settings.selected.some(country=>(country.boxes?.length?country.boxes:[[country.center[1],country.center[0],country.center[1],country.center[0]]]).some(b=>
    box.north>=b[1]-.5&&box.south<=b[3]+.5&&[-360,0,360].some(shift=>box.east+shift>=b[0]-dlon&&box.west+shift<=b[2]+dlon)));
}
export async function loadTracks(settings, csv, update = () => {}, signal, { root = dataRoot, index = traceBoundsIndex } = {}) {
  await mkdir(root, { recursive: true });
  const rows = [], seen = new Set(), knownJets=new Set(); let scanned = 0;
  const allowed = settings.allowedArchiveDays && new Set(settings.allowedArchiveDays), completeDays = new Map(), cacheRoot=join(root,"adsblol");
  const firstDay = new Date((settings.start - 600) * 1000).toISOString().slice(0, 10), lastDay = new Date((settings.end + settings.duration + 600) * 1000).toISOString().slice(0, 10);
  const add = items => { for(const row of items)if(isKnownJet(row))knownJets.add(row[0]); for (const row of items) if (nearSelection(row, settings) && (!allowed || allowed.has(new Date(row[1]*1000).toISOString().slice(0,10)))) {
    const key = `${row[0]}:${row[1]}`; if (seen.has(key)) continue; seen.add(key); rows.push(row);
    if (rows.length > 2_000_000) throw new Error("Track memory budget reached; narrow time or region");
  } };
  if (csv) add(parseCsv(csv));
  for await (const path of trackFiles(root)) {
    if(signal?.aborted)throw new Error("Job cancelled");
    // Daily archive filenames allow range searches to avoid reparsing every cached day.
    const archiveDay = path.replaceAll("\\", "/").match(/\/(\d{4}-\d{2}-\d{2})-[a-f0-9]{6}\.json$/i)?.[1];
    if (archiveDay && (archiveDay < firstDay || archiveDay > lastDay)) continue;
    if (archiveDay && allowed && !allowed.has(archiveDay)) continue;
    if (archiveDay && dirname(path)===cacheRoot) {
      if (!completeDays.has(archiveDay)) { try { await stat(join(cacheRoot,`${archiveDay}.complete`));completeDays.set(archiveDay,true); } catch { completeDays.set(archiveDay,false); } }
      if (!completeDays.get(archiveDay)) continue;
    }
    if (++scanned > 200_000) throw new Error("Local archive file limit reached");
    const info = await stat(path); if (info.size > 128 * 1024 * 1024) throw new Error("Split CSV files into chunks below 128 MB");
    if (/\.csv$/i.test(path)) {
      let header = "", batch = [];
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of lines) {
        if(signal?.aborted)throw new Error("Job cancelled");
        if (!header) { header = line; continue; } batch.push(line);
        if (batch.length === 4000) { add(parseCsv(`${header}\n${batch.join("\n")}`)); batch = []; }
      }
      if (batch.length) add(parseCsv(`${header}\n${batch.join("\n")}`));
    } else {
      const prior=index.get(path);
      if(prior&&prior.size===info.size&&prior.mtimeMs===info.mtimeMs&&prior.ctimeMs===info.ctimeMs&&!extentMayMatch(prior.box,settings)){
        for(const id of prior.jets||[])knownJets.add(id);
        if (!(scanned % 250)) update(`Indexed ${scanned} files; ${rows.length} relevant track points`);
        continue;
      }
      const raw = await readFile(path); const plain = /\.gz$/i.test(path) ? gunzipSync(raw, { maxOutputLength: 32_000_000 }) : raw;
      const items=readsbRows(JSON.parse(plain.toString("utf8")));
      if(index.size>=200_000&&!index.has(path))index.delete(index.keys().next().value);
      index.set(path,{size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,box:traceExtent(items),jets:[...new Set(items.filter(isKnownJet).map(row=>row[0]))]});
      add(items);
    }
    if (!(scanned % 250)) update(`Indexed ${scanned} files; ${rows.length} relevant track points`);
  }
  const grouped = new Map(); for (const row of rows) { if (!grouped.has(row[0])) grouped.set(row[0], []); grouped.get(row[0]).push(row); }
  // Drop known jets only. Missing type information must remain eligible.
  const usable = [...grouped.values()].filter(group => group.length >= 8 && !knownJets.has(group[0][0]) && !group.some(isKnownJet));
  if (usable.length > 6000) throw new Error("More than 6,000 aircraft; narrow the region or time");
  return usable.flatMap(group => group.sort((a, b) => a[1] - b[1]));
}
export function makeGrid(rows, settings, stepKm = settings.gridKm, centers) {
  const stepLat = stepKm / 111.32, seen = new Set(), grid = [];
  const add = (lat, lon) => {
    if (lat < -90 || lat > 90 || !inBounds(lon, lat, settings.bounds)) return;
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`; if (seen.has(key)) return;
    const code = settings.selected.find(country => insideCountry(lon, lat, country))?.code; if (!code) return;
    seen.add(key); grid.push([lat, lon, settings.altitude, code]);
  };
  const anchors = centers || rows.filter((_, i) => !(i % 5)).map(row => ({ lat: row[2], lon: row[3] }));
  for (const anchor of anchors) {
    const radius = centers ? Math.max(settings.gridKm * 1.5, stepKm * 2) : 28;
    for (let y = -radius; y <= radius + .001; y += stepKm) {
      const lat = Math.round((anchor.lat + y / 111.32) / stepLat) * stepLat;
      const stepLon = stepKm / (111.32 * Math.max(.025, Math.cos(lat * Math.PI / 180)));
      for (let x = -radius; x <= radius + .001; x += stepKm) {
        if (x*x + y*y > radius*radius) continue;
        add(lat, wrapLon(Math.round((anchor.lon + x / (111.32 * Math.max(.025, Math.cos(lat * Math.PI / 180)))) / stepLon) * stepLon));
        if (grid.length > 60_000) return null;
      }
    }
  }
  return grid;
}
export function coverage(rows, selected) {
  return selected.map(country => {
    const inCountry = rows.filter(row => nearCountry(row[3], row[2], country));
    const aircraft = new Set(inCountry.map(row => row[0])).size;
    return { code: country.code, samples: inCountry.length, aircraft,
      note: !aircraft ? "No usable historical tracks loaded here; this area cannot be assessed" : aircraft < 8 ? "Sparse loaded sample; missing aircraft and gaps may dominate the result" : "Loaded tracks exist; receiver completeness and low-altitude coverage remain unverified" };
  });
}
/* Download archives explicitly, with a byte cap. Stream TAR records; never extract paths. */
export async function acquireArchive(date, cacheRoot, limitBytes, update, signal) {
  const day = date.slice(0, 10); if (!/^20\d\d-\d\d-\d\d$/.test(day)) throw new Error("Invalid archive day");
  await mkdir(cacheRoot, { recursive: true });
  const marker = join(cacheRoot, `${day}.complete`);
  try { await stat(marker); return; } catch {}
  const year = day.slice(0, 4), repo = `https://api.github.com/repos/adsblol/globe_history_${year}/releases?per_page=100`;
  let release;
  for (let page = 1; page <= 10 && !release; page++) {
    const response = await fetch(`${repo}&page=${page}`, { signal, headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`Archive catalogue HTTP ${response.status}`);
    const releases = await response.json(); if (!Array.isArray(releases) || !releases.length) break;
    const matches = releases.filter(item => item.tag_name.includes(day.replaceAll("-", ".")) || item.tag_name.includes(day));
    release = matches.find(item => /prod/.test(item.tag_name)) || matches[0];
    if (!release && releases.at(-1)?.published_at?.slice(0,10) < day) break;
  }
  if (!release) throw new Error(`No ADSB.lol archive found for ${day}; import matching historical tracks locally`);
  const assets = release.assets.filter(asset => /\.tar\.[a-z]{2}$/.test(asset.name)).sort((a,b) => a.name.localeCompare(b.name));
  const total = assets.reduce((n, asset) => n + asset.size, 0);
  if (!assets.length || total > limitBytes) throw new Error(`Archive requires ${(total / 2**30).toFixed(1)} GB; configured download cap is ${(limitBytes / 2**30).toFixed(1)} GB. Import the day in data/ or raise DOPPLER_ARCHIVE_MAX_GB explicitly.`);
  let received = 0;
  async function *stream() { for (const asset of assets) {
    const url = new URL(asset.browser_download_url); if (url.hostname !== "github.com") throw new Error("Unexpected archive host");
    const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`Archive HTTP ${response.status}`);
    for await (const chunk of response.body) { received += chunk.length; if (received > limitBytes) throw new Error("Archive byte cap reached"); update(received / total, received, total); yield Buffer.from(chunk); }
  } }
  let buffer = Buffer.alloc(0), needed = 512, remaining = 0, name = "", content = [], accepted = false, traces = 0;
  for await (const chunk of stream()) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= needed) {
      const part = buffer.subarray(0, needed); buffer = buffer.subarray(needed);
      if (!remaining) {
        if (part.every(byte => byte === 0)) continue;
        name = part.subarray(0,100).toString().replace(/\0.*$/, "");
        const size = parseInt(part.subarray(124,136).toString().replace(/\0.*$/, "").trim(),8);
        if (!Number.isFinite(size) || size < 0) throw new Error("Malformed TAR header");
        remaining = Math.ceil(size/512)*512; needed = Math.min(remaining, 65536) || 512;
        accepted = /trace_full_[a-f0-9]{6}\.json(?:\.gz)?$/i.test(name) && [0,48].includes(part[156]) && size < 16_000_000;
        content = []; if (accepted) content.size = size;
      } else {
        if (accepted) content.push(Buffer.from(part)); remaining -= part.length;
        if (remaining) needed = Math.min(remaining,65536);
        else {
          if (accepted) {
            const raw = Buffer.concat(content).subarray(0,content.size);
            const plain = raw[0] === 31 && raw[1] === 139 ? gunzipSync(raw,{maxOutputLength:32_000_000}) : raw;
            const data = JSON.parse(plain.toString());
            if (/^[a-f0-9]{6}$/i.test(data.icao || "")) { await writeFile(join(cacheRoot, `${day}-${data.icao}.json`), plain); traces++; }
          }
          needed = 512;
        }
      }
    }
  }
  if (remaining || buffer.length || received !== total) throw new Error("Archive ended before all declared bytes were received");
  if (!traces) throw new Error("Archive contained no supported full traces");
  await writeFile(marker, JSON.stringify({ release: release.html_url, traces, received, license: "ODbL-1.0" }));
}
