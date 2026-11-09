import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, appendFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, extname } from "node:path";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { dataRoot, validateSearch, loadTracks, coverage, insideCountry, acquireArchive, aircraftTypesAvailable,clearTrackMetadataCache } from "./doppler-data.mjs";
import { recordingTimeFromMetadata, clockBatches, clockCount, archiveDaysForWindows, planSummary } from "./doppler-time.mjs";
import { inspectMedia, inspectOnlineMedia, validateSegment, shiftRecordingTime, onlineInspectArgs, onlineClipArgs, publicMediaUrl, byteRange, mediaMime, withTemporaryDownload } from "./doppler-media.mjs";
import { reviewedMeasurements, measurementCsv, candidateGridBatches, refinedGrid, polishGrid, rankValue, flightLeaders } from "./doppler-method.mjs";
import { terrainProvider } from "./doppler-terrain.mjs";
import { createTrackStore } from "./doppler-track-store.mjs";
import { nativeSession } from "./doppler-native.mjs";
import { automaticSearchInput, resultLeaderboard } from "./doppler-workflow.mjs";
import {saveUpload} from "./doppler-upload.mjs";
import {archiveInventory,clearArchiveDays} from "./doppler-cache.mjs";
import {fastYouTubeInfo} from "./doppler-youtube.mjs";
import {sessionWorkspace} from "./doppler-session.mjs";

const install = fileURLToPath(new URL("../runtime/", import.meta.url));
const workspace=sessionWorkspace(join(install,'sessions')),jobsRoot=workspace.root, binary = process.env.DOPPLER_BINARY || join(install, "bin", "dopplercrack");
const whisper = join(install, "whisper", "build", "bin", "whisper-cli"), model = join(install, "whisper", "models", "ggml-tiny.bin");
const windows = process.platform === "win32", jobs = new Map(), processes = new Map(), controllers = new Map();
const nativeSessions=new Map();
const backgroundTasks=new Map(),lastAccess=new Map(),runnerServers=new Set();
let workspaceReady,workspaceClosing=Promise.resolve();
let activeJob;
function setting(key) {
  if(process.env[key])return process.env[key];
  try{return readFileSync(new URL("../.env.local",import.meta.url),"utf8").split(/\r?\n/).find(line=>line.startsWith(`${key}=`))?.slice(key.length+1).trim().replace(/^['"]|['"]$/g,"")||"";}catch{return "";}
}
export function linuxPath(path) {
  if (!windows) return path;
  const match = path.replaceAll("\\", "/").match(/^([A-Za-z]):(\/.*)$/);
  if (!match) throw new Error("Doppler files must be on a WSL-accessible drive");
  return `/mnt/${match[1].toLowerCase()}${match[2]}`;
}
function run(job, command, args, timeout = 180_000, progress) {
  return new Promise((resolve, reject) => {
    if (job.state === "cancelled") return reject(new Error("Job cancelled"));
    const guarded=[linuxPath(fileURLToPath(new URL('../scripts/process-guard.py',import.meta.url))),command,...args];
    const child = spawn(windows ? "wsl.exe" : 'python3', windows ? ["--exec",'python3',...guarded] : guarded, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.cancel=()=>child.stdin.end();child.stdin.on('error',()=>{});
    processes.set(job.id, child); let stdout = "", stderr = "", lines = "";
    const timer = setTimeout(() => child.cancel(), timeout);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-2_000_000); });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-12000); lines += chunk.toString();
      const parts = lines.split("\n"); lines = parts.pop();
      if (progress) for (const line of parts) { try { const row = JSON.parse(line); if (row.total) progress(row.completed / row.total); } catch { if(progress.duration&&line.startsWith("out_time_us="))progress(Math.max(0,Math.min(1,Number(line.slice(12))/1e6/progress.duration))); } }
    });
    child.once("error", error => { clearTimeout(timer); processes.delete(job.id); reject(error); });
    child.once("close", code => { clearTimeout(timer); processes.delete(job.id);
      if (job.state === "cancelled") reject(new Error("Job cancelled"));
      else if (code !== 0) reject(new Error(`${command.split("/").at(-1)} failed or timed out: ${stderr.slice(-500)}`));
      else resolve({ stdout, stderr });
    });
  });
}
function stopChild(child){if(child?.cancel)child.cancel();else child?.kill();}
async function update(job, change) { Object.assign(job, change); }
async function getJob(id) {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Invalid job ID");
  if(!jobs.has(id))throw Object.assign(new Error('This recording session has ended. Load the recording for a fresh analysis.'),{status:410});
  lastAccess.set(id,Date.now());return jobs.get(id);
}
function background(job, work) {
  activeJob = job.id;
  const task=(async()=>{
    try { await work(); }
    catch (error) { if (job.state !== "cancelled") await update(job, { state: "error", stage: "Stopped", error: error.message }); }
    finally { controllers.delete(job.id);lastAccess.set(job.id,Date.now());if (activeJob === job.id) activeJob = undefined; }
  })();
  backgroundTasks.set(job.id,task);void task.finally(()=>backgroundTasks.delete(job.id));return task;
}
async function discardJob(id){
  const job=jobs.get(id);if(!job)return;
  const family=job.sourceJobId||job.id,related=[...jobs.values()].filter(item=>(item.sourceJobId||item.id)===family);
  for(const item of related){item.state='cancelled';controllers.get(item.id)?.abort();stopChild(processes.get(item.id));}
  await Promise.allSettled(related.map(item=>backgroundTasks.get(item.id)));
  for(const item of related){await workspace.removeJob(item.id);jobs.delete(item.id);lastAccess.delete(item.id);}
}
async function language(job, folder) {
  if (!existsSync(whisper) || !existsSync(model)) return { note: "Local speech model missing; run npm run doppler:install. You can still choose countries manually." };
  const output = join(folder,"speech");
  const runResult = await run(job, linuxPath(whisper), ["-m", linuxPath(model), "-f", linuxPath(join(folder,"speech.wav")), "-l", "auto", "-oj", "-of", linuxPath(output), "-t", "4"], 180_000);
  const data = JSON.parse(await readFile(`${output}.json`,"utf8"));
  const code = data.result?.language;
  const text = (data.transcription || []).map(row => row.text).join(" ").replace(/\[[^\]]*\]/g, "").trim().slice(0,1600);
  const confidence = Number((runResult.stderr + runResult.stdout).match(/auto-detected language:\s*\w+\s*\(p\s*=\s*([\d.]+)/i)?.[1]);
  if (!text || !code || (Number.isFinite(confidence) && confidence < .55)) return { note: "No sufficiently clear speech language in the 45-second sample. Country selection remains manual." };
  let name = code; try { name = new Intl.DisplayNames(["en"],{type:"language"}).of(code); } catch {}
  return { code, name, text, confidence: Number.isFinite(confidence) ? confidence : undefined, note: "Local multilingual tiny model; the first 45 seconds are a language hint, not speaker identification or geographic proof." };
}
async function probeMedia(job, media) {
  try { return JSON.parse((await run(job, "ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", linuxPath(media)])).stdout); }
  catch (error) { throw new Error(`Cannot read this recording. Use a valid audio/video file supported by your FFmpeg installation. ${error.message}`); }
}
function ytDlp(job, args, timeout = 180000,progress) {
  // The application's Node >=22 also serves yt-dlp's JavaScript runtime, including through WSL.
  return run(job, linuxPath(join(install, "python", "bin", "python")), ["-m", "yt_dlp", "--js-runtimes", `node:${linuxPath(process.execPath)}`, ...args], timeout,progress);
}
async function inspectSource(job, folder) {
  await update(job, { stage: "Reading source format, audio tracks and recording metadata", progress: 10 });
  if (job.sourceUrl) {
    let info;
    const controller=new AbortController();controllers.set(job.id,controller);
    try { info=await fastYouTubeInfo(job.sourceUrl,controller.signal); }
    catch { if(job.state==='cancelled')return; }
    try { if(!info)info = JSON.parse((await ytDlp(job, onlineInspectArgs(job.sourceUrl),45000)).stdout); }
    catch (error) { throw new Error(`Public video unavailable. Check the URL or upload a local copy; the loader does not use account cookies. ${error.message}`); }
    const media = inspectOnlineMedia(info);
    await writeFile(join(folder, "source.json"), JSON.stringify({ id: info.id, title: info.title, duration: media.duration, extractor: info.extractor_key, url: job.sourceUrl }));
    await update(job, { media, name: String(info.title || "Public video").slice(0, 180), sourceRecordingTime: { candidates: [], warnings: ["Public page publication dates are not recording timestamps. Enter the time of the selected portion after analysis."] } });
  } else {
    const metadata = await probeMedia(job, join(folder, job.sourceFile)), media = inspectMedia(metadata);
    if (media.duration && media.duration < 8) throw new Error("The recording must contain at least eight seconds of audio.");
    await writeFile(join(folder, "source.json"), JSON.stringify(metadata));
    await update(job, { media, sourceRecordingTime: recordingTimeFromMetadata(metadata) });
  }
  if (job.state === "cancelled") return;
  if(job.automatic&&!job.sourceUrl){
    const end=Math.min(1800,job.media.duration||60);
    await analyze(job,folder,validateSegment({start:0,end,audioStream:job.media.defaultAudioStream},job.media));
  }else await update(job, { state: "selecting", stage: "Choose timestamps before downloading audio", progress: 100 });
}
async function analyze(job, folder, segment) {
  await update(job, { state: "analyzing", stage: "Preparing the selected portion", progress: 3, segment, duration: undefined, events: undefined, error: undefined,
    result: undefined, estimate: undefined, coverage: undefined, recordingTime: undefined, metadataTime: undefined, language: undefined, previewReady: false,
    detectorVersion:undefined,automaticMeasurements:undefined,reviewedEvents:undefined,eventMeasurements:undefined,reviewedSettings:undefined });
  const recordingTime = shiftRecordingTime(job.sourceRecordingTime, segment.start);
  await update(job,{recordingTime,metadataTime:recordingTime?.utc});
  async function decode(media,sourceOffset,audioStream){
    await update(job,{stage:"Decoding the selected audio track",progress:22});
    try {
      await run(job,"ffmpeg",["-v","error","-nostdin","-y","-ss",String(sourceOffset),"-i",linuxPath(media),"-map",`0:${audioStream}`,"-t",String(segment.end-segment.start),"-vn","-sn","-dn","-ac","1","-ar","16000","-c:a","pcm_s16le",linuxPath(join(folder,"preview.wav"))]);
    }catch(error){throw new Error(`Cannot decode the selected audio track. Check the file or install a full FFmpeg build with its audio codec. ${error.message}`);}
  }
  if (job.sourceUrl) {
    await update(job,{stage:`yt-dlp · downloading audio ${segment.start}–${segment.end} s`,progress:5});
    await withTemporaryDownload(folder,async selectedFolder=>{
      const progress=fraction=>{job.progress=5+fraction*15;};progress.duration=segment.end-segment.start;
      await ytDlp(job,onlineClipArgs(job.sourceUrl,segment,linuxPath(join(selectedFolder,"media.%(ext)s"))),600000,progress);
      const name=(await readdir(selectedFolder)).find(name=>/^media\.[a-z0-9]{1,8}$/i.test(name));
      if(!name)throw new Error("No selected audio was downloaded. Upload a local copy of the recording.");
      const media=join(selectedFolder,name),downloadedInfo=inspectMedia(await probeMedia(job,media));
      const hash=createHash("sha256");for await(const chunk of createReadStream(media))hash.update(chunk);
      job.sha256=hash.digest("hex");job.sha256Scope="selected-download";
      await decode(media,0,downloadedInfo.defaultAudioStream);
    });
    job.downloadRemoved=true;
  }else await decode(join(jobsRoot,job.sourceJobId||job.id,job.sourceFile),segment.start,segment.audioStream);
  const decoded = await probeMedia(job, join(folder, "preview.wav")), duration = Number(decoded.format?.duration);
  if (!Number.isFinite(duration) || duration < 8 || duration > 1800.01) throw new Error("The selected portion must decode to eight seconds–30 minutes of audio. Check its start/end positions and audio track.");
  const selectionNote = duration < segment.end - segment.start - .25 ? "Audio ended before the requested clip boundary; only the available decoded audio is analyzed." : undefined;
  await update(job,{stage:"Detecting spoken language",progress:25,duration,previewReady:true,selectionNote,segment:{...segment,actualEnd:segment.start+duration}});
  await run(job,"ffmpeg",["-v","error","-nostdin","-y","-i",linuxPath(join(folder,"preview.wav")),"-t","45","-c:a","pcm_s16le",linuxPath(join(folder,"speech.wav"))]);
  let speech;try { speech = await language(job,folder); } catch (error) { speech = {note:`Language check unavailable: ${error.message}`}; }
  if (job.state === "cancelled") return;
  await update(job,{stage:"Building the audio spectrogram",progress:45,language:speech});
  await run(job,"ffmpeg",["-v","error","-nostdin","-y","-i",linuxPath(join(folder,"preview.wav")),"-ar","2048","-c:a","pcm_s16le",linuxPath(join(folder,"audio.wav"))]);
  await run(job,linuxPath(binary),["spectrogram",linuxPath(join(folder,"audio.wav")),linuxPath(join(folder,"spectrum.bin"))]);
  await update(job,{stage:"Checking sustained tones and Doppler geometry",progress:65,spectrumReady:true});
  await run(job,linuxPath(binary),["discover",linuxPath(join(folder,"spectrum.bin")),linuxPath(join(folder,"events.json"))]);
  const observations=JSON.parse(await readFile(join(folder,"events.json"),"utf8"));
  await observationsFile(folder,observations.events);
  if(job.state==="cancelled")return;
  await update(job,{state:"ready",stage:observations.events.length?"Audio ready. Choose countries and recording times.":"Insufficient aircraft-like signal in this portion.",progress:100,
    events:observations.events,detectorVersion:observations.detectorVersion,automaticMeasurements:observations.measurements,detection:{rejected:observations.rejected,diagnostics:observations.diagnostics}});
}
function selectedEvents(job, input) {
  const available=[...new Map([...(job.events||[]),...(job.reviewedEvents||[])].map(event=>[event.id,event])).values()];
  const events = input.ridgeCsv ? parseRidges(input.ridgeCsv, job.duration) : available.filter(event => input.eventIds?.includes(event.id));
  if (!events.length || events.length > 8) throw new Error("Select one to eight acoustic proposals or import reviewed ridge CSV");
  events.sort((a,b)=>a.start-b.start);
  reviewedMeasurements(events,input,job.duration);
  return events;
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function inputDigest(input) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return digest(JSON.stringify(canonical(input)));
}
async function observationsFile(folder, events) {
  await writeFile(join(folder, "ridges.csv"), events.flatMap(event => event.points.map(point => [event.id, ...point].join(","))).join("\n"));
}
async function nativeSearch(job, folder, settings, window, cells, stem, progress, timeout, filterOnly=false,incumbents) {
  await writeFile(join(folder, `${stem}.csv`), cells.map(row => row.slice(0, 3).join(",")).join("\n"));
  let incumbentPath="-";
  if(!filterOnly&&settings.scoreMode==="trace"&&settings.measurements.length===1&&incumbents){
    incumbentPath=join(folder,`${stem}-incumbents.csv`);
    const lines=incumbents.candidates?.length>=1200?[`heat,${rankValue(incumbents.candidates.at(-1))}`]:[];
    for(const leader of incumbents.flightLeaders||[])if(leader.flights.length===1)lines.push(`flight,${leader.flights[0]},${rankValue(leader)}`);
    await writeFile(incumbentPath,lines.join("\n"));incumbentPath=linuxPath(incumbentPath);
  }
  const limit=timeout||Math.min(3600,Math.max(60,Number(setting("DOPPLER_TIMEOUT_SECONDS"))||900))*1000;
  const session=nativeSessions.get(job.id);
  if(session)await session.request({cells:linuxPath(join(folder,`${stem}.csv`)),output:linuxPath(join(folder,`${stem}.json`)),incumbents:incumbentPath,start:window.start,end:window.end,step:settings.timeStep,filter:filterOnly,progress,timeoutMs:limit});
  else await run(job, linuxPath(binary), ["locate", linuxPath(join(folder, "ridges.csv")), linuxPath(join(folder, "tracks.csv")), linuxPath(join(folder, `${stem}.csv`)),linuxPath(join(folder,"reviewed-measurements.csv")),linuxPath(join(jobsRoot,job.id,"spectrum.bin")), String(window.start), String(window.end), String(settings.timeStep), String(settings.threads), String(settings.soundSpeed), linuxPath(join(folder, `${stem}.json`)),filterOnly?"1":"0",settings.scoreMode==="trace"?"0":"1",settings.silence?"1":"0",incumbentPath],limit, progress);
  return JSON.parse(await readFile(join(folder, `${stem}.json`), "utf8"));
}
export function mergeCandidates(...groups) {
  const seen = new Set(), unique = [];
  for (const candidate of groups.flat().sort((a, b) => rankValue(a)-rankValue(b) || a.clock - b.clock || a.lat - b.lat || a.lon - b.lon)) {
    const key = `${candidate.lat.toFixed(7)}:${candidate.lon.toFixed(7)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(candidate); if (unique.length === 1200) break; }
  }
  return unique;
}
async function estimateSearch(job, input) {
  const settings = validateSearch(input, job.duration), events = selectedEvents(job, input), { plan } = settings;
  settings.measurements=reviewedMeasurements(events,input,job.duration);settings.scoreMode=input.scoreMode||"spectral";settings.silence=!!input.silence;
  const previousState = job.result ? "complete" : "ready", folder = join(jobsRoot, job.id, "estimate");
  await update(job, { state: "estimating", stage: "Planning dates, clock batches and archive requirements", progress: 5, error: undefined, estimate: undefined,reviewedEvents:events,eventMeasurements:settings.measurements,reviewedSettings:{scoreMode:settings.scoreMode,terrainMode:input.terrainMode||"auto",silence:settings.silence} });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder,"reviewed-measurements.csv"),measurementCsv(settings.measurements));
  const controller = new AbortController(); controllers.set(job.id, controller);
  const missingArchiveDays = plan.archiveDays.filter(day => !existsSync(join(dataRoot, "adsblol", `${day}.complete`)));
  const warnings = ["ETA is approximate. Track density, geographic pruning and local refinement can change runtime substantially."];
  warnings.push("Published-method search uses a 200 m physics grid, followed by 100 m scoring at every surviving area. Automatic terrain downloads are additional to this ETA.");
  warnings.push("Bounded trace search reuses winning scores across chunks and clock batches. Later pruning and archive/spectrum reuse can make the search faster than isolated calibration predicts.");
  if (plan.mode === "estimated" || plan.clockTrials > 720) warnings.push("Searching uncertain dates and daily times can take much longer than searching a known recording time. A narrower date/time range is the largest speed improvement.");
  if (input.online && missingArchiveDays.length) warnings.push(`${missingArchiveDays.length} uncached archive days may need downloads. Download size and speed are unknown; download time is not included in the ETA. Daily byte caps still apply.`);
  if (plan.clippedFuture) warnings.push("Future dates/times were clipped to the current time.");
  let calibration;
  if(input.automatic){
    if(job.state!=="cancelled")await update(job,{state:previousState,stage:"Ready to search",progress:100,estimate:{createdAt:new Date().toISOString(),inputDigest:inputDigest(input),plan:planSummary(plan),missingArchiveDays,warnings:["Search time depends on flight density and archive downloads. A measured ETA appears after the first batch.",...(plan.windowCount>1?["The selected daily hours are searched independently on every date."]:[]),...(plan.clippedFuture?["Future recording times are excluded."]:[])]}});
    return;
  }
  const batches = plan.windows.flatMap(window => clockBatches(window, plan.timeStep));
  // Try at most three dates, without downloading anything or running the full search.
  const samples = [...new Set([0, Math.floor((batches.length - 1) / 2), batches.length - 1])];
  for (const index of samples) {
    const window = batches[index], sampleSettings = { ...settings, ...window }, before = performance.now();
    job.stage = `Checking local tracks for ETA (${new Date(window.start * 1000).toISOString().slice(0, 10)})`;
    const rows = await loadTracks(sampleSettings, input.tracksCsv, stage => { job.stage = stage; }, controller.signal);
    const gridStarted=performance.now();
    const grid=[];let gridCellCount=0,seed=1234567;
    for await(const chunk of candidateGridBatches(rows,sampleSettings,settings.measurements[0],{signal:controller.signal}))for(const cell of chunk){
      gridCellCount++;if(grid.length<128)grid.push(cell);else{seed=(Math.imul(seed,1664525)+1013904223)>>>0;const index=seed%gridCellCount;if(index<128)grid[index]=cell;}
    }
    if (rows.length < 8 || !grid.length) continue;
    const preparationSeconds = (performance.now() - before) / 1000;
    const gridPreparationSeconds=(performance.now()-gridStarted)/1000;
    await observationsFile(folder, events);
    await writeFile(join(folder, "tracks.csv"), rows.map(row => row.join(",")).join("\n"));
    const cells = Array.from({ length: Math.min(128, grid.length) }, (_, i) => grid[Math.floor(i * grid.length / Math.min(128, grid.length))]);
    const clockSamples=clockCount(window,plan.timeStep),probeWindow=window;
    job.stage = "Calibrating a small C workload on this computer"; job.progress = 60;
    const wallStart = performance.now();
    let measured;
    try { measured = await nativeSearch(job, folder, sampleSettings, probeWindow, cells, "calibration", undefined, 30000); }
    catch (error) { if (controller.signal.aborted) return; warnings.push(`Local calibration unavailable: ${error.message}`); break; }
    if (!Number.isFinite(measured.elapsedSeconds)) {
      warnings.push("Rebuild the C worker (npm run doppler:install) to enable measured ETA calibration."); break;
    }
    const nativeSeconds = Math.max(.0001, measured.elapsedSeconds), launchSeconds = Math.max(0, (performance.now() - wallStart) / 1000 - nativeSeconds);
    let repeatedPreparationSeconds=preparationSeconds;
    if(batches.length>1){
      job.stage="Timing cached historical-track indexing for the full range";
      const warmStarted=performance.now();
      await loadTracks(sampleSettings,input.tracksCsv,stage=>{job.stage=stage;},controller.signal);
      repeatedPreparationSeconds=(performance.now()-warmStarted)/1000+gridPreparationSeconds;
    }
    const fineCells=gridCellCount*9;
    const compute = nativeSeconds * (gridCellCount + fineCells) / cells.length * plan.clockTrials / clockSamples;
    const additionalColdDays=Math.max(0,plan.archiveDays.length-archiveDaysForWindows([window],job.duration).length);
    const overhead = (repeatedPreparationSeconds + launchSeconds * (input.refine === false ? 1 : 2)) * batches.length+additionalColdDays*preparationSeconds;
    const typical = Math.max(1, compute + overhead), uncertainty = plan.windowCount > 1 ? 6 : 3;
    calibration = { lowerSeconds: Math.max(1, Math.round(typical * .35)), upperSeconds: Math.max(2, Math.ceil(typical * uncertainty)),
      sampleDate: new Date(window.start * 1000).toISOString().slice(0, 10), sampleCells: cells.length, sampleTrackPoints: rows.length, threads: measured.threads,
      method: `C calibration on 128 reservoir-sampled receiver cells across all ${gridCellCount.toLocaleString()} cells in the sampled 200 m corridor grid. Includes an upper-work allowance for 100 m expansion, loading and other clock batches. Receiver height is approximate during calibration only; terrain downloads are excluded. The number of actual physics survivors and other dates' traffic can change runtime substantially.` };
    break;
  }
  if (!calibration) warnings.push("No representative local tracks/grid are available for calibration. A reliable ETA cannot be given before the needed history is loaded.");
  if (job.state === "cancelled") return;
  await update(job, { state: previousState, stage: "Search plan ready — review the ETA before starting", progress: 100,
    estimate: { createdAt: new Date().toISOString(), inputDigest: inputDigest(input), plan: planSummary(plan), calibration, missingArchiveDays: input.online ? missingArchiveDays : [], warnings } });
}
async function search(job, input) {
  const settings = validateSearch(input, job.duration), events = selectedEvents(job, input), { plan } = settings;
  settings.measurements=reviewedMeasurements(events,input,job.duration);settings.scoreMode=input.scoreMode||"spectral";settings.silence=!!input.silence;
  const folder = join(jobsRoot, job.id), batches = plan.windows.flatMap(window => clockBatches(window, plan.timeStep));
  await update(job, { state: "searching", stage: "Loading historical flight tracks", progress: 2, error: undefined, result: undefined,
    searchPlan: planSummary(plan), completedBatches: 0, totalBatches: batches.length, remainingSeconds: undefined,reviewedEvents:events,eventMeasurements:settings.measurements,reviewedSettings:{scoreMode:settings.scoreMode,terrainMode:input.terrainMode||"auto",silence:settings.silence} });
  const controller = new AbortController(); controllers.set(job.id, controller);
  const terrain=terrainProvider({mode:input.terrainMode||"auto",altitude:settings.altitude,signal:controller.signal,update:stage=>{job.stage=stage;},maxTiles:Math.min(4096,Math.max(1,Number(setting("DOPPLER_TERRAIN_MAX_TILES"))||1024))});
  const started = performance.now(), downloaded = new Set(), missingDates = new Set(), archiveFailures = new Map(), cumulative = new Map();
  let completedClocks = 0, testedClocks = 0, skipped = 0, coarseSurvivors=0,gridChunks=0;
  let result = { candidates: [], cellsEvaluated: 0, trials: 0, elapsedSeconds: 0, eventCount: events.length, threads: 0 };
  await observationsFile(folder, events);
  await writeFile(join(folder,"reviewed-measurements.csv"),measurementCsv(settings.measurements));
  const hashes = { observations: digest(JSON.stringify(events)), importedTracks: input.tracksCsv ? digest(input.tracksCsv) : undefined };
  await writeFile(join(folder, "search.json"), JSON.stringify({ input: { ...input, tracksCsv: undefined, ridgeCsv: undefined }, settings: { ...settings, selected: settings.selected.map(row => row.code) }, hashes,
    media: { sourceJobId: job.sourceJobId, sourceUrl: job.sourceUrl, name: job.name, sha256: job.sha256, sha256Scope: job.sha256Scope, segment: job.segment } }));
  if (input.tracksCsv) await writeFile(join(folder, "input-tracks.csv"), input.tracksCsv);
  await writeFile(join(folder, "search-batches.jsonl"), "");
  let trackStore,trackSnapshot;
  try {
  for (let index = 0; index < batches.length; index++) {
    if (controller.signal.aborted || job.state === "cancelled") return;
    const window = batches[index], sampleSettings = { ...settings, ...window }, clocks = clockCount(window, settings.timeStep), prefix = `Batch ${index + 1}/${batches.length}`;
    const progress = fraction => { job.progress = Math.max(job.progress, 2 + 96 * (completedClocks + clocks * fraction) / plan.clockTrials); };
    if (input.online) for (const day of archiveDaysForWindows([window], job.duration)) {
      if(settings.allowedArchiveDays&&!settings.allowedArchiveDays.includes(day))continue;
      if (downloaded.has(day) || archiveFailures.has(day)) continue;
      job.stage = `${prefix} · loading archive ${day}`;
      try {
        await acquireArchive(day, join(dataRoot, "adsblol"), Math.min(64, Math.max(1, Number(setting("DOPPLER_ARCHIVE_MAX_GB")) || 4)) * 2 ** 30,
          (fraction, bytes, total) => { progress(fraction * .12); job.stage = `${prefix} · downloading ${day}: ${(bytes / 2 ** 30).toFixed(2)} / ${(total / 2 ** 30).toFixed(2)} GB`; }, controller.signal);
        downloaded.add(day);
        if(trackStore)await trackStore.extendArchive(day);
      } catch (error) { if (controller.signal.aborted) return; archiveFailures.set(day, error.message); }
    }
    job.stage = `${prefix} · indexing historical tracks`; progress(.14);
    if(!trackStore)trackStore=await createTrackStore(settings,input.tracksCsv,{folder:join(folder,"track-snapshot"),signal:controller.signal,update:stage=>{job.stage=`${prefix} · ${stage}`;}});
    const rows = await trackStore.query(sampleSettings);
    for (const row of coverage(rows, settings.selected)) {
      const total = cumulative.get(row.code) || { ...row, samples: 0, aircraft: 0 };
      if (row.aircraft > total.aircraft) total.note = row.note;
      total.samples += row.samples; total.aircraft = Math.max(total.aircraft, row.aircraft); cumulative.set(row.code, total);
    }
    const loadedCoverage = [...cumulative.values()];
    await update(job, { coverage: loadedCoverage });
    let batchCells=0,batchCandidates=0,chunks=0;
    if(rows.length>=8){
      const tracksText = rows.map(row => row.join(",")).join("\n");
      await writeFile(join(folder, "tracks.csv"), tracksText);
      const session=nativeSession({binary:linuxPath(binary),args:[linuxPath(join(folder,"ridges.csv")),linuxPath(join(folder,"tracks.csv")),linuxPath(join(folder,"reviewed-measurements.csv")),linuxPath(join(jobsRoot,job.id,"spectrum.bin")),String(settings.threads),String(settings.soundSpeed),settings.scoreMode==="trace"?"0":"1",settings.silence?"1":"0"],signal:controller.signal,onChild:child=>processes.set(job.id,child)});
      nativeSessions.set(job.id,session);
      try {
      for await(const originalGrid of candidateGridBatches(rows,sampleSettings,settings.measurements[0],{signal:controller.signal})){
        chunks++;gridChunks++;job.stage=`${prefix} · terrain / 200 m corridor chunk ${chunks}`;progress(.2);
        const chunkProgress=fraction=>progress(.2+.78*(chunks-1+fraction)/(chunks+1));
        const grid=await terrain.apply(originalGrid);
        const filtered=await nativeSearch(job,folder,settings,window,grid,"filtered",fraction=>{chunkProgress(fraction*.4);job.stage=`${prefix} · 200 m physics filters, chunk ${chunks}`;},undefined,true);
        coarseSurvivors+=filtered.candidates.length;batchCells+=filtered.cellsEvaluated;
        result.cellsEvaluated+=filtered.cellsEvaluated;result.trials+=filtered.trials;result.elapsedSeconds+=filtered.elapsedSeconds;
        result.threads=filtered.threads;
        result.silenceRejections=(result.silenceRejections||0)+(filtered.silenceRejections||0);
        // Expand every physics survivor, including low-scoring areas, rather than six peaks.
        const expanded=refinedGrid(filtered.candidates,sampleSettings);
        for(let offset=0;offset<expanded.length;offset+=12000){
          const refined=await terrain.apply(expanded.slice(offset,offset+12000));
          const fine=await nativeSearch(job,folder,settings,window,refined,"refined",fraction=>{chunkProgress(.4+.6*(offset+fraction*refined.length)/expanded.length);job.stage=`${prefix} · 100 m ${settings.scoreMode} scoring, chunk ${chunks}`;},undefined,false,result);
          batchCells+=fine.cellsEvaluated;batchCandidates+=fine.candidates.length;
          result={...fine,cellsEvaluated:result.cellsEvaluated+fine.cellsEvaluated,trials:result.trials+fine.trials,elapsedSeconds:result.elapsedSeconds+fine.elapsedSeconds,
            silenceRejections:(result.silenceRejections||0)+(fine.silenceRejections||0),flightLeaders:flightLeaders([...(result.flightLeaders||[]),...(fine.flightLeaders||fine.candidates)]),candidates:mergeCandidates(result.candidates,fine.candidates)};
        }
      }
      }finally{nativeSessions.delete(job.id);await session.close();processes.delete(job.id);}
      testedClocks+=clocks;
      await appendFile(join(folder,"search-batches.jsonl"),JSON.stringify({...window,status:chunks?"searched":"no-eligible-corridors",points:rows.length,tracksHash:digest(tracksText),gridKm:.2,refinedGridKm:.1,clocks,chunks,cells:batchCells,candidates:batchCandidates})+"\n");
    }else{
      skipped++;missingDates.add(new Date(window.start*1000).toISOString().slice(0,10));
      await appendFile(join(folder,"search-batches.jsonl"),JSON.stringify({...window,status:"no-tracks",points:rows.length})+"\n");
    }
    completedClocks += clocks; progress(0);
    const remaining = completedClocks < plan.clockTrials ? (performance.now() - started) / 1000 * (plan.clockTrials - completedClocks) / completedClocks : 0;
    await update(job, { completedBatches: index + 1, remainingSeconds: remaining });
  }
  } finally {if(trackStore){trackSnapshot=trackStore.stats;await trackStore.close();}}
  const best=result.candidates[0]?rankValue(result.candidates[0]):0,spread=Math.max(.000001,(result.candidates.at(-1)?rankValue(result.candidates.at(-1)):1)-best);
  const limitations=["Independent reconstruction of Colsto's published method; original code and several numerical settings were not released. No validated location or calibrated probability is implied.",input.automatic?"Automatic tone discovery and profiled bounds can miss faint, partial or overlapping flyovers; a coherent moving tone can also come from a source other than an aircraft.":"Reviewed event bounds can exclude the true flight if measured incorrectly. Short/partial curves may not constrain speed and slant distance.","Constant sound speed, stationary receiver and stable source tone are assumptions. Wind, refraction, changing RPM, recording-clock drift and interpolation errors remain unmodeled.","Linear ECEF interpolation rejects gaps over 30 seconds and never extrapolates. Unknown aircraft types remain eligible; known jets are excluded.","All generated 200 m physics survivors are expanded to 100 m scoring. This resolution is not a real-world accuracy claim; fine clock offsets between chosen steps may still be missed."];
  limitations.push(terrain.mode==="constant"?"Explicit constant receiver ellipsoidal height was used at every candidate. This approximates terrain and is a departure from the video.":"Receiver heights use cached Skadi HGT terrain plus EGM96 geoid undulation; DEM surface age/resolution and vertical-datum errors remain uncertainty sources.");
  limitations.push(settings.silence?"Silence filter enabled: intervening unmatched flyovers within the maximum selected-event CPA slant distance reject a candidate, with no distance multiplier. This is a hearing heuristic; incomplete ADS-B or acoustic masking can reject valid candidates.":"Silence filter disabled. Enable it only after inspecting the continuous interval for missing flyovers; this differs from the main two-event demonstration.");
  if (events.length < 2) limitations.push("Only one flyover event: mirrored or otherwise ambiguous locations can have similar scores.");
  if(settings.allowedArchiveDays)limitations.push(`Only UTC archive day(s) ${settings.allowedArchiveDays.join(", ")} were used. Aircraft positions across excluded day boundaries are not loaded or extrapolated.`);
  if (plan.clockTrials > 720) limitations.push("A wider date/time search produces more opportunities for coincidental fits; residual scores do not compensate for this or establish recording dates.");
  if (skipped) limitations.push(`${skipped}/${batches.length} clock batches had no usable tracks/grid and were not assessed. Affected UTC dates: ${[...missingDates].join(", ")}.`);
  for (const [date, error] of archiveFailures) limitations.push(`Archive ${date} unavailable/incomplete: ${error}. Only independently loaded local tracks were used for that date.`);
  const loadedCoverage = [...cumulative.values()].map(row => ({ ...row, note: `${row.note}. Counts: accumulated samples and peak aircraft per clock batch; completeness across dates is unverified.` }));
  const final = { ...result,methodVersion:2,workflowVersion:3,scoreMode:settings.scoreMode,coarseSurvivors,gridChunks,trackSnapshot,flightLeaders:result.flightLeaders||flightLeaders(result.candidates),terrain:{mode:terrain.mode,sources:[...terrain.sources.values()]},
    candidates: result.candidates.map(candidate => ({ ...candidate, country: settings.selected.find(country => insideCountry(candidate.lon, candidate.lat, country))?.code, relativeFit: Math.exp(-3 * (rankValue(candidate)-best) / spread) })),
    gridKm:.2,refinedGridKm:.1,status: result.candidates.length ? "ranked" : "inconclusive", validated: false, limitations, coverage: loadedCoverage,
    timeSearch: { ...planSummary(plan), testedClockTrials: testedClocks, skippedBatches: skipped, unassessedDates: [...missingDates], archiveFailures: [...archiveFailures].map(([date, error]) => ({ date, error })) } };
  final.leaderboard=resultLeaderboard(final).map(candidate=>({...candidate,country:settings.selected.find(country=>insideCountry(candidate.lon,candidate.lat,country))?.code}));
  if (job.state !== "cancelled") await update(job, { state: "complete", stage: result.candidates.length ? "Search complete" : "No matching locations in the available flight data", progress: 100, remainingSeconds: 0, result: final });
}
function refinementCandidate(job,input){
  if(job.result?.methodVersion!==2)throw new Error("Run the transcript-audited search before refining a flight combination");
  const selected=[...(job.result.flightLeaders||[]),...job.result.candidates].find(c=>c.lat===input.lat&&c.lon===input.lon&&c.clock===input.clock&&JSON.stringify(c.flights)===JSON.stringify(input.flights));
  if(!selected)throw new Error("Select an existing ranked flight hypothesis to refine");return selected;
}
async function refineSearch(job,input){
  const target=refinementCandidate(job,input),root=join(jobsRoot,job.id),saved=JSON.parse(await readFile(join(root,"search.json"),"utf8"));
  const settings=validateSearch(saved.input,job.duration),events=parseRidges(await readFile(join(root,"ridges.csv"),"utf8"),job.duration);
  settings.measurements=reviewedMeasurements(events,saved.input,job.duration).map((m,i)=>({...m,flightId:target.flights[i]}));settings.scoreMode=saved.input.scoreMode||"spectral";settings.silence=!!saved.input.silence;
  const originalWindow=settings.plan.windows.find(w=>target.clock>=w.start&&target.clock<=w.end);if(!originalWindow)throw new Error("Candidate clock is outside the saved search windows");
  const radiusSeconds=Math.max(2,settings.timeStep*2),window={start:Math.max(originalWindow.start,target.clock-radiusSeconds),end:Math.min(originalWindow.end,target.clock+radiusSeconds)};settings.timeStep=.25;
  const id=randomUUID(),folder=join(root,"refinements",id);await mkdir(folder,{recursive:true});await writeFile(join(folder,"before.json"),JSON.stringify(job.result));
  await update(job,{state:"searching",stage:"Refining selected flight geometry at 25 m",progress:1,error:undefined});
  const controller=new AbortController();controllers.set(job.id,controller);
  const terrain=terrainProvider({mode:saved.input.terrainMode||"auto",altitude:settings.altitude,signal:controller.signal,update:stage=>{job.stage=stage;}});
  const imported=existsSync(join(root,"input-tracks.csv"))?await readFile(join(root,"input-tracks.csv"),"utf8"):undefined;
  // Keep every aircraft for the silence test; constrain association by event in C.
  const rows=await loadTracks({...settings,...window},imported,stage=>{job.stage=stage;},controller.signal);
  await observationsFile(folder,events);await writeFile(join(folder,"reviewed-measurements.csv"),measurementCsv(settings.measurements));await writeFile(join(folder,"tracks.csv"),rows.map(r=>r.join(",")).join("\n"));
  const grid=polishGrid(target,settings),fine=await nativeSearch(job,folder,settings,window,await terrain.apply(grid),"geometry-25m",fraction=>{job.progress=10+fraction*88;job.stage=`Selected-flight geometry refinement ${Math.round(fraction*100)}%`;});
  const candidates=mergeCandidates(job.result.candidates,fine.candidates),best=candidates[0]?rankValue(candidates[0]):0,spread=Math.max(.000001,(candidates.at(-1)?rankValue(candidates.at(-1)):1)-best);
  const entry={id,flights:target.flights,center:{lat:target.lat,lon:target.lon},gridKm:.025,radiusM:500,startUtc:new Date(window.start*1000).toISOString(),endUtc:new Date(window.end*1000).toISOString(),timeStep:.25,cellsEvaluated:fine.cellsEvaluated,candidates:fine.candidates.length};
  const result={...job.result,candidates:candidates.map(c=>({...c,country:settings.selected.find(country=>insideCountry(c.lon,c.lat,country))?.code,relativeFit:Math.exp(-3*(rankValue(c)-best)/spread)})),
    flightLeaders:flightLeaders([...(job.result.flightLeaders||[]),...(fine.flightLeaders||fine.candidates)]),polishedGridKm:.025,refinements:[...(job.result.refinements||[]),entry],
    cellsEvaluated:job.result.cellsEvaluated+fine.cellsEvaluated,trials:job.result.trials+fine.trials,elapsedSeconds:job.result.elapsedSeconds+fine.elapsedSeconds,
    limitations:[...job.result.limitations,"Selected flight geometry was locally refined at 25 m within 500 m of its selected point and within the saved clock window. Other flight combinations were not globally refined to this resolution; cell spacing is not validated accuracy."]};
  await writeFile(join(folder,"refinement.json"),JSON.stringify({...entry,terrain:{mode:terrain.mode,sources:[...terrain.sources.values()]},result:fine}));
  if(job.state!=="cancelled")await update(job,{state:"complete",stage:fine.candidates.length?"Selected flight geometry refined; inspect the modeled curves":"No finer complete fit; earlier hypotheses retained",progress:100,remainingSeconds:0,result});
}
export function parseRidges(csv,duration) {
  const groups=new Map();
  for(const line of String(csv).trim().split(/\r?\n/).slice(0,513)){
    const [id,t,hz,weight=1]=line.split(",").map(Number);
    if(![id,t,hz,weight].every(Number.isFinite))continue;
    if(!Number.isInteger(id)||id<1||id>999||t<0||t>duration||hz<15||hz>900||weight<=0)throw new Error("Invalid ridge measurement");
    if(!groups.has(id))groups.set(id,[]);groups.get(id).push([t,hz,Math.min(weight,10)]);
  }
  if(!groups.size||groups.size>8)throw new Error("Ridge CSV needs event,time_seconds,frequency_hz,weight, up to eight events");
  return [...groups].map(([id,points])=>{points.sort((a,b)=>a[0]-b[0]);if(points.length<8||points.length>64)throw new Error("Each ridge needs 8–64 points");return{id,start:points[0][0],end:points.at(-1)[0],dropHz:points[0][1]-points.at(-1)[1],points};});
}
export function dopplerStatus(){return{available:existsSync(binary)&&aircraftTypesAvailable,aircraftTypes:aircraftTypesAvailable,methodVersion:2,language:existsSync(whisper)&&existsSync(model),mode:windows?"WSL":"native",note:"Run npm run doppler:install to build the C worker, aircraft-type reference and local language model"};}
async function body(request,max){let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>max)throw new Error("Request exceeds upload limit");chunks.push(chunk);}return Buffer.concat(chunks);}
async function serveMedia(request, response, path, contentType) {
  const info = await stat(path); let range;
  try { range = byteRange(request.headers.range, info.size); }
  catch { response.writeHead(416, { "Content-Range": `bytes */${info.size}` }); response.end(); return; }
  response.writeHead(range ? 206 : 200, { "Content-Type": contentType, "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Length": range ? range.end - range.start + 1 : info.size,
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
  const stream = createReadStream(path, range || undefined); response.on("close", () => stream.destroy()); stream.on("error", () => response.destroy()).pipe(response);
}
export function startDopplerRunner({port=3856,secret=process.env.DOPPLER_RUNNER_SECRET,archiveRoot=join(dataRoot,"adsblol")}={}){
  if(!secret||secret.length<20)throw new Error("DOPPLER_RUNNER_SECRET must have at least 20 characters");
  workspaceReady||=workspaceClosing.then(()=>workspace.initialize());
  const server=createServer(async(request,response)=>{
    const send=(status,value)=>{response.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});response.end(JSON.stringify(value));};
    const auth=Buffer.from(request.headers.authorization||""), expected=Buffer.from(`Bearer ${secret}`);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return send(401,{error:"Unauthorized"});
    const url=new URL(request.url,"http://127.0.0.1");
    let reservedId;
    try{
      await workspaceReady;
      if(request.method==="GET"&&url.pathname==="/health")return send(200,dopplerStatus());
      if(request.method==="GET"&&url.pathname==="/cache")return send(200,{...await archiveInventory(archiveRoot),busy:!!activeJob});
      if(request.method==="POST"&&url.pathname==="/cache/clear"){
        if(activeJob)return send(409,{error:"Wait for the current job to finish before clearing flight data"});
        const input=JSON.parse((await body(request,64000)).toString());
        if(activeJob)return send(409,{error:"Wait for the current job to finish before clearing flight data"});
        activeJob="cache-maintenance";
        try{const cleared=await clearArchiveDays(archiveRoot,input.dates);clearTrackMetadataCache();return send(200,{...await archiveInventory(archiveRoot),cleared,busy:false});}
        finally{if(activeJob==="cache-maintenance")activeJob=undefined;}
      }
      const match=url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(?:\/(search|estimate|refine|segment|cancel|discard|touch|audio|source|preview|spectrum))?$/);
      if(match&&request.method==='POST'&&match[2]==='discard'){await discardJob(match[1]);return send(200,{discarded:true});}
      if(match){const job=await getJob(match[1]);
        if(request.method==='POST'&&match[2]==='touch')return send(200,{active:true});
        if(request.method==="GET"&&["audio","source","preview","spectrum"].includes(match[2])){
          if(match[2]==="source"&&(!job.sourceFile||!/^media\.[a-z0-9]{1,8}$/i.test(job.sourceFile)))return send(409,{error:"Use the public video player, or load a local recording"});
          if(match[2]==="preview"&&!job.previewReady)return send(409,{error:"Selected-portion preview is being prepared"});
          const name=match[2]==="source"?job.sourceFile:match[2]==="preview"?"preview.wav":match[2]==="spectrum"?"spectrum.bin":"speech.wav",path=join(jobsRoot,match[2]==="source"?(job.sourceJobId||job.id):job.id,name);
          if(!existsSync(path))return send(409,{error:"Media is being prepared"});
          await serveMedia(request,response,path,match[2]==="spectrum"?"application/octet-stream":mediaMime(name));return;
        }
        if(request.method==="GET"&&!match[2])return send(200,job);
        if(request.method==="POST"&&match[2]==="cancel"){job.state="cancelled";controllers.get(job.id)?.abort();stopChild(processes.get(job.id));await update(job,{stage:"Cancelled"});return send(200,job);}
        if(request.method==="POST"&&match[2]==="segment"){
          if(activeJob)return send(409,{error:"Another Doppler job is running"});
          const input=JSON.parse((await body(request,4000)).toString());
          if(!job.media)throw new Error("Load the source recording before selecting a portion");
          const segment=validateSegment(input,job.media);
          if(activeJob)return send(409,{error:"Another Doppler job is running"});
          const id=randomUUID(),folder=join(jobsRoot,id);reservedId=id;activeJob=id;await mkdir(folder,{recursive:true});
          const analysis={id,automatic:job.automatic,name:job.name,sourceUrl:job.sourceUrl,sourceFile:job.sourceFile,sourceJobId:job.sourceJobId||job.id,media:job.media,sourceRecordingTime:job.sourceRecordingTime,
            sha256:job.sourceFile?job.sha256:undefined,sha256Scope:job.sourceFile?"original-upload":undefined,state:"analyzing",stage:"Queued selected portion",progress:1,createdAt:new Date().toISOString(),segment};
          jobs.set(id,analysis);void background(analysis,()=>analyze(analysis,folder,segment));return send(202,analysis);
        }
        if(request.method==="POST"&&match[2]==="refine"){
          if(activeJob)return send(409,{error:"Another Doppler job is running"});const input=JSON.parse((await body(request,4000)).toString());refinementCandidate(job,input);
          if(activeJob)return send(409,{error:"Another Doppler job is running"});void background(job,()=>refineSearch(job,input));return send(202,job);
        }
        if(request.method==="POST"&&["search","estimate"].includes(match[2])){
          if(activeJob)return send(409,{error:"Another Doppler job is running"});
          let input=JSON.parse((await body(request,28_000_000)).toString());
          if(input.automatic)input=automaticSearchInput(job,input);
          validateSearch(input,job.duration);selectedEvents(job,input);
          if(activeJob)return send(409,{error:"Another Doppler job is running"});
          void background(job,()=>match[2]==="estimate"?estimateSearch(job,input):search(job,input));return send(202,job);
        }
      }
      if(request.method==="POST"&&url.pathname==="/jobs"){
        if(activeJob)return send(409,{error:"Another Doppler job is running"});if(!dopplerStatus().available)return send(503,{error:dopplerStatus().note});
        const id=randomUUID(),folder=join(jobsRoot,id);reservedId=id;activeJob=id;await mkdir(folder,{recursive:true});
        const job={id,automatic:request.headers["x-doppler-automatic"]==="1",name:decodeURIComponent(request.headers["x-media-name"]||"Recording").slice(0,180),state:"inspecting",stage:"Queued",progress:1,createdAt:new Date().toISOString()};jobs.set(id,job);
        if(request.headers["content-type"]?.startsWith("application/json")){
          const input=JSON.parse((await body(request,4000)).toString());job.sourceUrl=publicMediaUrl(input.url);
          void background(job,()=>inspectSource(job,folder));
        }else{
          const extension=extname(job.name).toLowerCase();job.sourceFile=`media${/^\.[a-z0-9]{1,8}$/.test(extension)?extension:".bin"}`;
          const uploaded=await saveUpload(request,join(folder,job.sourceFile));job.sha256=uploaded.sha256;job.sourceBytes=uploaded.bytes;job.sha256Scope="original-upload";void background(job,()=>inspectSource(job,folder));
        }
        return send(202,job);
      }
      return send(404,{error:"Unknown Doppler endpoint"});
    }catch(error){if(reservedId&&activeJob===reservedId){activeJob=undefined;await discardJob(reservedId);}return send(error.status||400,{error:error.message});}
  });
  runnerServers.add(server);server.requestTimeout=0;
  const sweep=setInterval(()=>{
    const families=new Map();for(const job of jobs.values()){const root=job.sourceJobId||job.id;families.set(root,Math.max(families.get(root)||0,lastAccess.get(job.id)||Date.parse(job.createdAt)));}
    for(const [id,time]of families)if(Date.now()-time>30*60000&&![...jobs.values()].some(job=>(job.sourceJobId||job.id)===id&&job.id===activeJob))void discardJob(id).catch(()=>{});
  },60000);sweep.unref();
  server.on('close',()=>{
    clearInterval(sweep);runnerServers.delete(server);if(runnerServers.size)return;
    const initialized=workspaceReady;workspaceReady=undefined;
    server.cleanup=(async()=>{await initialized;for(const id of [...jobs.keys()])await discardJob(id);await workspace.close();})();workspaceClosing=server.cleanup;
  });
  server.listen(port,"127.0.0.1");return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){startDopplerRunner();console.log("Dopplercrack listening on 127.0.0.1:3856");}
