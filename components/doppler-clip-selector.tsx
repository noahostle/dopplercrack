"use client";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Play, Scissors } from "lucide-react";
import { mediaTime, parseMediaTime, youtubeId } from "../lib/doppler-media.mjs";
import type { DopplerJob, DopplerSegment } from "../lib/doppler-types";

type YouTubePlayer = { getCurrentTime: () => number; seekTo: (seconds: number, allowSeekAhead: boolean) => void; pauseVideo: () => void; destroy: () => void };
type YouTubeAPI = { Player: new (element: HTMLElement, options: { videoId: string; host: string; width: string; height: string; playerVars: Record<string, string | number>; events: { onReady: () => void; onError: () => void } }) => YouTubePlayer };
declare global { interface Window { YT?: YouTubeAPI; onYouTubeIframeAPIReady?: () => void } }
let youtubeLoading: Promise<YouTubeAPI> | undefined;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeLoading) return youtubeLoading;
  youtubeLoading = new Promise<YouTubeAPI>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => { youtubeLoading = undefined; reject(new Error("Player did not load")); }, 15000);
    window.onYouTubeIframeAPIReady = () => { previous?.(); clearTimeout(timeout); if (window.YT) resolve(window.YT); else reject(new Error("Player unavailable")); };
    const script = document.createElement("script"); script.src = "https://www.youtube.com/iframe_api"; script.async = true;
    script.onerror = () => { clearTimeout(timeout); youtubeLoading = undefined; reject(new Error("Player unavailable")); };
    document.head.appendChild(script);
  });
  return youtubeLoading;
}
export function DopplerClipSelector({ job, disabled, analyze }: { job: DopplerJob; disabled: boolean; analyze: (segment: DopplerSegment) => void }) {
  const media = job.media!, duration = media.duration;
  const [start, setStart] = useState(mediaTime(job.segment?.start ?? 0)), [end, setEnd] = useState(mediaTime(job.segment?.end ?? Math.min(60, duration || 60)));
  const [audioStream, setAudioStream] = useState(job.segment?.audioStream ?? media.defaultAudioStream), [playerReady, setPlayerReady] = useState(false), [notice, setNotice] = useState("");
  const [showPlayer,setShowPlayer]=useState(false);
  const native = useRef<HTMLMediaElement | null>(null), youtube = useRef<YouTubePlayer | null>(null), youtubeMount = useRef<HTMLDivElement>(null), liveEnd = useRef(NaN), previewing = useRef(false);
  const id = youtubeId(job.sourceUrl), low = parseMediaTime(start), high = parseMediaTime(end), length = high - low;
  useEffect(() => { liveEnd.current = high; }, [high]);
  const valid = Number.isFinite(low) && Number.isFinite(high) && low >= 0 && length >= 8 && length <= 1800 && (!duration || high <= duration + .1);
  useEffect(() => {
    if (!id || !showPlayer || !youtubeMount.current) return;
    let cancelled = false, player: YouTubePlayer | undefined;
    const host = youtubeMount.current, target = document.createElement("div"); host.appendChild(target);
    void loadYouTube().then(api => {
      if (cancelled) return;
      player = new api.Player(target, { videoId: id, host: "https://www.youtube-nocookie.com", width: "100%", height: "220", playerVars: { playsinline: 1, rel: 0, origin: window.location.origin },
        events: { onReady: () => { if (!cancelled) setPlayerReady(true); }, onError: () => { if (!cancelled) setNotice("Embedded playback unavailable. Open the source and enter clip positions below."); } } });
      youtube.current = player;
    }).catch(() => { if (!cancelled) setNotice("Embedded playback unavailable. Open the source and enter clip positions below."); });
    const timer = setInterval(() => { if (previewing.current && youtube.current && youtube.current.getCurrentTime() >= liveEnd.current) { youtube.current.pauseVideo(); previewing.current = false; } }, 200);
    return () => { cancelled = true; clearInterval(timer); player?.destroy(); youtube.current = null; host.replaceChildren(); };
  }, [id,showPlayer]);
  function position() { return youtube.current && playerReady ? youtube.current.getCurrentTime() : native.current?.currentTime; }
  function mark(which: "start" | "end") {
    const value = position(); if (value === undefined || !Number.isFinite(value)) return;
    if (which === "start") setStart(mediaTime(value)); else setEnd(mediaTime(value));
  }
  function jump() {
    if (!valid) return; previewing.current = true;
    if (youtube.current && playerReady) youtube.current.seekTo(low, true);
    else if (native.current) native.current.currentTime = low;
  }
  const source = `/api/doppler?job=${job.id}&action=source`;
  return <section className="doppler-clip" aria-label="Select a recording portion">
    <div className="doppler-clip-heading"><Scissors size={16} /><strong>SELECT TIMESTAMPS</strong></div>
    {job.sourceUrl ? <>
      {id && <details className="doppler-source-preview" onToggle={e=>setShowPlayer(e.currentTarget.open)}><summary>Preview on YouTube</summary>{showPlayer&&<div className="doppler-youtube-player" ref={youtubeMount} />}</details>}
    </> : media.kind === "audio" ? <audio ref={element => { native.current = element; }} className="doppler-source-audio" src={source} controls preload="metadata" onLoadedMetadata={() => setPlayerReady(true)} onError={() => setNotice("Browser playback is unavailable for this format. Enter positions; a standard audio preview is created after analysis.")} onTimeUpdate={() => { if (previewing.current && native.current && native.current.currentTime >= liveEnd.current) { native.current.pause(); previewing.current = false; } }} />
      : <video ref={element => { native.current = element; }} className="doppler-source-video" src={source} controls preload="metadata" onLoadedMetadata={() => setPlayerReady(true)} onError={() => setNotice("Browser playback is unavailable for this format. Enter positions; a standard audio preview is created after analysis.")} onTimeUpdate={() => { if (previewing.current && native.current && native.current.currentTime >= liveEnd.current) { native.current.pause(); previewing.current = false; } }} />}
    {notice && <p className="doppler-help" role="status">{notice}</p>}
    <div className="doppler-field-grid"><label>Clip start · source position<input aria-label="Clip start" value={start} onChange={event => setStart(event.target.value)} placeholder="00:00:00" /></label><label>Clip end · source position<input aria-label="Clip end" value={end} onChange={event => setEnd(event.target.value)} placeholder="00:01:00" /></label></div>
    {!!duration && <div className="doppler-clip-sliders"><label>IN<input aria-label="Clip start slider" type="range" min="0" max={duration} step=".1" value={Number.isFinite(low) ? low : 0} onChange={event => setStart(mediaTime(Math.max(0, Math.min(+event.target.value, (Number.isFinite(high) ? high : duration) - 8))))} /></label><label>OUT<input aria-label="Clip end slider" type="range" min="0" max={duration} step=".1" value={Number.isFinite(high) ? high : duration} onChange={event => setEnd(mediaTime(Math.min(duration, Math.max(+event.target.value, (Number.isFinite(low) ? low : 0) + 8))))} /></label></div>}
    {(!job.sourceUrl||showPlayer)&&<div className="doppler-clip-markers"><button type="button" disabled={!playerReady} onClick={() => mark("start")}>MARK IN</button><button type="button" disabled={!playerReady} onClick={() => mark("end")}>MARK OUT</button><button type="button" disabled={!playerReady || !valid} onClick={jump}>Go to IN</button></div>}
    {media.audioTracks.length > 1 && <label>Audio track<select aria-label="Audio track" value={audioStream} onChange={event => setAudioStream(+event.target.value)}>{media.audioTracks.map(track => <option key={track.index} value={track.index}>Track {track.index} · {track.codec}{track.language ? ` · ${track.language}` : ""}{track.title ? ` · ${track.title}` : ""}</option>)}</select></label>}
    <p className={valid ? "doppler-clip-duration" : "doppler-time-warning"}>{valid ? `${mediaTime(length)} selected` : "Select a valid 8-second–30-minute portion within the source. Use seconds, MM:SS or HH:MM:SS; decimals are supported."}</p>
    <button className="doppler-run" type="button" disabled={disabled || !valid} onClick={() => analyze({ start: low, end: high, audioStream })}><Play size={15} /> {job.sourceUrl?"DOWNLOAD & ANALYZE AUDIO":"ANALYZE SELECTED PORTION"}</button>
    {job.previewReady && <div className="doppler-clip-preview"><strong><AudioLines size={14} /> ANALYZED AUDIO PORTION</strong>{job.segment&&<small>Source positions {mediaTime(job.segment.start)}–{mediaTime(job.segment.actualEnd??job.segment.end)}</small>}<audio controls preload="metadata" src={`/api/doppler?job=${job.id}&action=preview`} /><small>Full selected audio in a browser-compatible format. Acoustic ridges, speech checks and clock zero all refer to this portion.</small>{job.selectionNote && <p>{job.selectionNote}</p>}</div>}
  </section>;
}
