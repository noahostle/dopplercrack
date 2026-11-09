// Recording-time evidence and bounded clock planning. Never use upload dates or file mtimes.
const DAY = 86400, FIRST_SUPPORTED = Date.UTC(2000, 0, 1) / 1000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const validStamp = (seconds, now) => Number.isFinite(seconds) && seconds >= FIRST_SUPPORTED && seconds <= now + DAY;

export function recordingTimeFromMetadata(metadata, now = Date.now() / 1000) {
  const candidates = [];
  const tags = [
    ["format", metadata?.format?.tags],
    ...(metadata?.streams || []).map((stream, index) => [`${stream.codec_type || "stream"} stream ${index}`, stream.tags]),
  ];
  for (const [scope, values] of tags) for (const [tag, raw] of Object.entries(values || {})) {
    const key = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rank = /(?:recordingtime|recordingdate|daterecorded|datetimeoriginal|dateoriginal|originationdatetime)$/.test(key) ? 0
      : /quicktimecreationdate$/.test(key) ? 1 : /^(?:creationtime|creationdate|date|datetime|recordeddate)$/.test(key) ? 2 : -1;
    if (rank < 0 || typeof raw !== "string") continue;
    // EXIF uses colons in the date; QuickTime frequently appends a numeric UTC offset.
    const text = raw.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T");
    const source = `${scope}: ${tag}`;
    try { dateValue(text.slice(0, 10)); } catch { continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text) && validStamp(Date.parse(`${text}T00:00:00Z`) / 1000, now)) {
      candidates.push({ source, raw, date: text, rank }); continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(text)) continue;
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text), seconds = Date.parse(zoned ? text : `${text}Z`) / 1000;
    if (!validStamp(seconds, now)) continue;
    candidates.push({ source, raw, ...(zoned ? { utc: iso(seconds) } : { local: text }), rank });
  }
  candidates.sort((a, b) => a.rank - b.rank || Number(!a.utc && !a.local) - Number(!b.utc && !b.local) || Number(!a.utc) - Number(!b.utc));
  const best = candidates[0], warnings = [];
  if (!best) return { candidates: [], warnings: ["No usable recording date/time was found in embedded media metadata. Enter it, or supply estimated dates and a daily time range."] };
  if (best.utc && candidates.some(candidate => candidate.utc && Math.abs(Date.parse(candidate.utc) - Date.parse(best.utc)) > 300000)) warnings.push("Embedded timestamps disagree by more than five minutes. Review the selected tag before searching.");
  if (best.local) warnings.push("This embedded time has no timezone. Enter its UTC offset or supply the recording time in UTC; a country does not establish the timezone.");
  if (best.date) warnings.push("Metadata contains a date only. Supply an estimated time range for that date.");
  warnings.push("Embedded creation tags can describe an export or edit. Confirm that this time represents the first recorded audio sample.");
  return { ...(best.utc ? { utc: best.utc } : {}), ...(best.local ? { local: best.local } : {}), ...(best.date ? { date: best.date } : {}), source: best.source, candidates: candidates.map(({ source, raw, utc, local, date }) => ({ source, raw, utc, local, date })), warnings };
}

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("Enter earliest and latest estimated dates");
  const seconds = Date.parse(`${value}T00:00:00Z`) / 1000;
  if (!Number.isFinite(seconds) || iso(seconds).slice(0, 10) !== value) throw new Error("Invalid estimated date");
  return seconds;
}
function timeValue(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value || "");
  if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) throw new Error("Enter an earliest and latest estimated time of day (UTC)");
  return +match[1] * 3600 + +match[2] * 60 + +(match[3] || 0);
}
// Convert a wall-clock window independently on every day. Intl supplies IANA
// historical offsets, including DST; a fixed browser offset would be wrong.
function wallWindows(from, to, low, high, timeZone) {
  let format;
  try { format = new Intl.DateTimeFormat("en-CA", {timeZone, year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}); }
  catch { throw new Error("Choose a valid recording timezone"); }
  const wall = utc => {
    const p = Object.fromEntries(format.formatToParts(new Date(utc*1000)).map(p=>[p.type,p.value]));
    return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)/1000;
  };
  const windows=[];
  for(let day=from;day<=to;day+=DAY){
    const a=day+low,b=day+high+(high<low?DAY:0);
    // Offset-constant UTC intervals. Hour sampling discovers transitions; binary
    // search resolves their exact second (including half-hour DST transitions).
    let begin=a-15*3600, offset=wall(begin)-begin;
    const stop=b+15*3600;
    function emit(end){const start=Math.max(begin,a-offset),last=Math.min(end,b-offset);if(start<=last)windows.push({start,end:last});}
    for(let probe=begin+3600;probe<=stop+3600;probe+=3600){
      const edge=Math.min(probe,stop+1), next=wall(edge)-edge;
      if(next!==offset){let left=edge-3600,right=edge;while(right-left>1){const mid=Math.floor((left+right)/2);if(wall(mid)-mid===offset)left=mid;else right=mid;}emit(right-1);begin=right;offset=wall(right)-right;}
      if(edge===stop+1){emit(stop);break;}
    }
  }
  windows.sort((a,b)=>a.start-b.start);
  const merged=[];for(const w of windows){const prev=merged.at(-1);if(prev&&w.start<=prev.end+1)prev.end=Math.max(prev.end,w.end);else merged.push(w);}
  if(!merged.length)throw new Error("This local time does not occur on the selected date because the clocks change. Widen the daily time range.");
  return merged;
}
export const clockCount = (window, step) => Math.floor((window.end - window.start + .001) / step) + 1;
export function clockBatches(window, step) {
  // Bound both numerical work and the amount of historical data loaded at once.
  const count = clockCount(window, step), size = Math.min(720, Math.floor(10800 / step) + 1), batches = [];
  for (let index = 0; index < count; index += size) batches.push({ start: window.start + index * step, end: window.start + (Math.min(count, index + size) - 1) * step });
  return batches;
}
export function archiveDaysForWindows(windows, duration) {
  const days = new Set();
  for (const window of windows) for (let day = Math.floor((window.start - 600) / DAY) * DAY; day <= window.end + duration + 600; day += DAY) days.add(iso(day).slice(0, 10));
  return [...days].sort();
}
export function buildClockPlan(input, duration, now = Date.now() / 1000) {
  if (!Number.isFinite(duration) || duration < 8 || duration > 1800) throw new Error("Analyze the recording before planning a search");
  const recordingStart=input.recordingStart;
  if(recordingStart){
    if(!['exact','range'].includes(recordingStart.mode))throw new Error('Choose an exact recording start or a start-time range');
    const exact=recordingStart.mode==='exact';
    input={...input,timeRange:{...recordingStart,dateTo:exact?recordingStart.dateFrom:recordingStart.dateTo,timeTo:exact?recordingStart.timeFrom:recordingStart.timeTo},timeStep:exact?1:recordingStart.stepSeconds};
  }
  const step = Number(input.timeStep ?? 2);
  if (!Number.isFinite(step) || step < .5 || step > 3600) throw new Error("Clock step must be between 0.5 and 3600 seconds");
  const windows = [], mode = recordingStart?.mode==='exact'?"known":input.timeRange ? "estimated" : "known";
  if (input.timeRange) {
    const { dateFrom, dateTo, timeFrom, timeTo, timeZone = "UTC" } = input.timeRange;
    const from = dateValue(dateFrom), to = dateValue(dateTo), low = timeValue(timeFrom), high = timeValue(timeTo);
    if (to < from || to - from >= 366 * DAY) throw new Error("Estimated dates must be ordered and span at most 366 days");
    windows.push(...wallWindows(from, to, low, high, timeZone));
  } else {
    if (![input.startUtc, input.endUtc].every(value => typeof value === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))) throw new Error("Enter the recording date/time in UTC, or choose estimated dates");
    const start = Date.parse(input.startUtc) / 1000, end = Date.parse(input.endUtc) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 366 * DAY) throw new Error("Supply an ordered recording-time window spanning at most 366 days");
    // Keep each data load bounded to one day while preserving the caller's clock lattice.
    const size = Math.floor(DAY / step) + 1, total = clockCount({ start, end }, step);
    for (let i = 0; i < total; i += size) windows.push({ start: start + i * step, end: start + (Math.min(total, i + size) - 1) * step });
  }
  if (windows[0].start < FIRST_SUPPORTED) throw new Error("Recording dates before 2000 are not supported");
  const recordingOffsetSeconds=recordingStart?Number(input.recordingOffsetSeconds||0):0;
  if(!Number.isFinite(recordingOffsetSeconds)||recordingOffsetSeconds<0||recordingOffsetSeconds>366*DAY)throw new Error('Invalid recording portion offset');
  for(const window of windows){window.start+=recordingOffsetSeconds;window.end+=recordingOffsetSeconds;}
  const clippedFuture = windows.some(window => window.end > now);
  const usable = windows.filter(window => window.start <= now).map(window => ({ ...window, end: Math.min(window.end, now) }));
  if (!usable.length) throw new Error("The recording date range is in the future");
  const trials = usable.reduce((sum, window) => sum + clockCount(window, step), 0);
  return { mode, recordingOffsetSeconds, timeZone: input.timeRange?.timeZone || "UTC", windows: usable, start: usable[0].start, end: usable.at(-1).end, timeStep: step, clockTrials: trials,
    windowCount: usable.length, batchCount: usable.reduce((sum, window) => sum + clockBatches(window, step).length, 0),
    archiveDays: archiveDaysForWindows(usable, duration), clippedFuture };
}

export function planSummary(plan) {
  return { mode: plan.mode, recordingOffsetSeconds:plan.recordingOffsetSeconds, timeZone: plan.timeZone, startUtc: iso(plan.start), endUtc: iso(plan.end), windowCount: plan.windowCount, clockTrials: plan.clockTrials,
    batchCount: plan.batchCount, timeStep: plan.timeStep, archiveDays: plan.archiveDays, clippedFuture: plan.clippedFuture };
}
