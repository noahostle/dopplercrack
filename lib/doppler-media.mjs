// Picker hints only: the backend probes actual content, not filename/MIME claims.
export const DOPPLER_AUDIO_EXTENSIONS = ["wav", "wave", "bwf", "mp3", "m4a", "m4b", "aac", "flac", "ogg", "oga", "opus", "aif", "aiff", "aifc", "wma", "amr", "caf", "ac3", "mka", "au", "snd", "ape", "wv"];
export const DOPPLER_VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "wmv", "asf", "flv", "mpg", "mpeg", "mpe", "m2v", "mts", "m2ts", "ts", "vob", "3gp", "3g2", "ogv", "mxf"];
export const DOPPLER_MEDIA_ACCEPT = ["audio/*", "video/*", ...new Set([...DOPPLER_AUDIO_EXTENSIONS, ...DOPPLER_VIDEO_EXTENSIONS].map(ext => `.${ext}`))].join(",");
export function mediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const ms = Math.round(seconds * 1000), whole = Math.floor(ms / 1000);
  return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}${ms % 1000 ? `.${String(ms % 1000).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
}
export function parseMediaTime(value) {
  const parts = String(value).trim().split(":");
  if (parts.length > 3 || parts.some(part => !/^\d+(?:\.\d{1,3})?$/.test(part))) return NaN;
  const numbers = parts.map(Number);
  if (numbers.some((part, index) => index > 0 && part >= 60) || parts.slice(0, -1).some(part => part.includes("."))) return NaN;
  return numbers.reduce((sum, part) => sum * 60 + part, 0);
}
export function youtubeId(raw) {
  try {
    const url = new URL(raw), host = url.hostname.toLowerCase().replace(/^www\./, "");
    const id = host === "youtu.be" ? url.pathname.split("/")[1] : ["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host) ? url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] : "";
    return /^[\w-]{11}$/.test(id || "") ? id : "";
  } catch { return ""; }
}
