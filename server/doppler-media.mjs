import {youtubeId} from "../lib/doppler-media.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
function streamDuration(stream) {
  const [n, d] = String(stream.time_base || "").split("/").map(Number);
  const tagged = String(stream.tags?.DURATION || "").match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  return positive(stream.duration) || (n && d ? positive(Number(stream.duration_ts) * n / d) : undefined) || (tagged ? +tagged[1] * 3600 + +tagged[2] * 60 + +tagged[3] : undefined);
}
export function inspectMedia(metadata) {
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const audio = streams.filter(stream => stream.codec_type === "audio");
  if (!audio.length) throw new Error("This file has no audio track. Choose an audio recording or a video containing sound.");
  const preferred = audio.find(stream => stream.disposition?.default === 1) || audio[0];
  return { kind: streams.some(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic) ? "video" : "audio",
    format: metadata.format?.format_long_name || metadata.format?.format_name || "Detected media", duration: positive(metadata.format?.duration) || streamDuration(preferred),
    defaultAudioStream: preferred.index, audioTracks: audio.map(stream => ({ index: stream.index, codec: stream.codec_name || "unknown", channels: stream.channels,
      sampleRate: positive(stream.sample_rate), language: stream.tags?.language, title: stream.tags?.title, duration: streamDuration(stream) })) };
}
export function inspectOnlineMedia(info) {
  if (info.is_live || info.live_status === "is_live") throw new Error("Choose a recorded video; live streams do not have stable clip boundaries.");
  const duration = positive(info.duration);
  if (!duration) throw new Error("The public video did not provide a usable duration. Upload a local copy to select a portion.");
  if (duration < 8) throw new Error("The recording must contain at least eight seconds of audio.");
  return { kind: "video", format: `${info.extractor_key || "Public video"} · audio extracted locally`, duration, audioTracks: [] };
}
export function validateSegment(input, media) {
  const start = input?.start, end = input?.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("Choose the start and end of one continuous portion to analyze.");
  if (end - start < 8 || end - start > 1800) throw new Error("Select a portion between eight seconds and 30 minutes. Split edited recordings into separate continuous portions.");
  if (media.duration && end > media.duration + .1) throw new Error("The selected portion ends beyond the source recording.");
  const audioStream = input.audioStream === undefined ? media.defaultAudioStream : Number(input.audioStream);
  if (media.audioTracks.length && !media.audioTracks.some(track => track.index === audioStream)) throw new Error("Select an available audio track.");
  return { start, end, audioStream };
}
export function shiftRecordingTime(recordingTime, start) {
  if (!recordingTime) return undefined;
  const shifted = { ...recordingTime, offsetSeconds: start, warnings: [...recordingTime.warnings] };
  if (recordingTime.utc) { shifted.sourceUtc = recordingTime.utc; shifted.utc = new Date(Date.parse(recordingTime.utc) + start * 1000).toISOString(); }
  if (recordingTime.local) shifted.local = new Date(Date.parse(`${recordingTime.local}Z`) + start * 1000).toISOString().replace(/Z$/, "");
  if (start) shifted.warnings.push(`Recording-time candidate advanced by ${start} seconds to the selected portion's first sample. This assumes the source before that point is continuous; edited footage needs a manually verified clip time.`);
  return shifted;
}
export function publicMediaUrl(raw) {
  const url = new URL(raw);
  const id=youtubeId(raw);
  if (url.protocol !== "https:" || url.username || url.password || !id || (url.port && url.port !== "443")) throw new Error("Paste a YouTube video link, or upload an audio/video file.");
  return `https://www.youtube.com/watch?v=${id}`;
}
const youtubeOptions=["--ignore-config","--no-playlist","--socket-timeout","15","--retries","1","--fragment-retries","1","--no-check-formats"];
export function onlineInspectArgs(url) { return [...youtubeOptions,"--skip-download","--ignore-no-formats-error","--extractor-retries","0","--extractor-args","youtube:player_client=web;player_skip=configs,js,initial_data;skip=hls,dash,translated_subs","--print","%(.{id,title,duration,live_status,is_live,extractor_key})j","--",publicMediaUrl(url)]; }
export function onlineClipArgs(url, segment, output) {
  validateSegment(segment,{audioTracks:[]});
  // Audio-only and a single bounded fetch. FFmpeg seeks the remote stream;
  // never fall back to downloading an entire video or a second speech sample.
  return [...youtubeOptions,"--download-sections",`*${segment.start}-${segment.end}`,"-f","bestaudio[protocol=https]/bestaudio","--downloader","ffmpeg","--downloader-args","ffmpeg:-progress pipe:2 -nostats","-o",output,"--",publicMediaUrl(url)];
}
export async function withTemporaryDownload(folder,work){
  const root=resolve(folder),temporary=await mkdtemp(join(root,"download-"));
  try{return await work(temporary);}finally{
    // Only remove the new directory owned by this download, including partials.
    if(dirname(resolve(temporary))!==root)throw new Error("Invalid temporary download path");
    await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:150});
  }
}
export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid byte range");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2])), end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw new Error("Unsatisfiable byte range");
  return { start, end };
}
export function mediaMime(name) {
  const ext = name.toLowerCase().split(".").at(-1);
  return ({ mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", mpg: "video/mpeg", mpeg: "video/mpeg", "3gp": "video/3gpp", ogv: "video/ogg", wav: "audio/wav", wave: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", aif: "audio/aiff", aiff: "audio/aiff", wma: "audio/x-ms-wma" })[ext] || "application/octet-stream";
}
