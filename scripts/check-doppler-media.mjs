// Real demux/decode/upload/clip controls. All local fixtures are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { join } from "node:path";
import { startDopplerRunner, linuxPath } from "../server/doppler-runner.mjs";
const folder = fileURLToPath(new URL("../runtime/media-verification/", import.meta.url));
await mkdir(folder, { recursive: true });
function command(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "wsl.exe" : name, process.platform === "win32" ? ["--exec", name, ...args] : args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject); child.once("close", code => code ? reject(new Error(output.slice(-2000))) : resolve(output));
  });
}
const secret = "synthetic-media-verification-secret", server = startDopplerRunner({ port: 0, secret }); await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${secret}` };
async function wait(job) {
  const until = Date.now() + 330000;
  while (Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 400)); job = await (await fetch(`${url}/jobs/${job.id}`, { headers })).json(); if (!["inspecting", "analyzing"].includes(job.state)) return job; }
  throw new Error("Media job timeout");
}
async function select(source, start = 8, end = 20, audioStream) {
  const response = await fetch(`${url}/jobs/${source.id}/segment`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ start, end, audioStream }) });
  let job = await response.json(); assert.equal(response.status, 202, JSON.stringify(job)); job = await wait(job); assert.equal(job.state, "ready", JSON.stringify(job));
  assert.notEqual(job.id, source.id); assert.ok(Math.abs(job.duration - (end - start)) < .1); assert.equal(job.segment.start, start); return job;
}
async function upload(name, path) {
  const response = await fetch(`${url}/jobs`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "X-Media-Name": encodeURIComponent(name) }, body: await readFile(path) });
  assert.equal(response.status, 202); return wait(await response.json());
}
async function checkPreview(job, expected = 170) {
  const response = await fetch(`${url}/jobs/${job.id}/preview`, { headers }); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /audio\/wav/);
  const data = Buffer.from(await response.arrayBuffer()); let offset = 12, audioOffset, rate;
  while (offset + 8 < data.length) { const size = data.readUInt32LE(offset + 4), name = data.toString("ascii", offset, offset + 4); if (name === "fmt ") rate = data.readUInt32LE(offset + 12); if (name === "data") { audioOffset = offset + 8; break; } offset += 8 + size + size % 2; }
  assert.equal(rate, 16000); assert.ok(audioOffset); let crossings = 0;
  for (let i = rate; i < 2 * rate; i++) if (data.readInt16LE(audioOffset + 2 * i) <= 0 && data.readInt16LE(audioOffset + 2 * (i + 1)) > 0) crossings++;
  assert.ok(Math.abs(crossings - expected) <= 2, `selected audio should be ${expected} Hz, got ${crossings}; wrong track or seek`);
  const range = await fetch(`${url}/jobs/${job.id}/preview`, { headers: { ...headers, Range: "bytes=0-43" } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 44);
}
try {
  if (process.argv.includes("--youtube")) {
    // Google's public IFrame API demonstration, not a person/case investigation.
    const response = await fetch(`${url}/jobs`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://www.youtube.com/watch?v=M7lc1UVf-VE" }) });
    let source = await wait(await response.json()); assert.equal(source.state, "selecting", JSON.stringify(source)); assert.ok(source.media.duration > 60); assert.equal(source.events, undefined);
    const clip = await select(source, 10, 22); assert.equal(clip.sha256Scope, "selected-download"); assert.equal(clip.recordingTime?.utc, undefined, "publication time must not become recording time");
    assert.equal(clip.downloadRemoved,true);
    assert.equal((await fetch(`${url}/jobs/${clip.id}/discard`,{method:'POST',headers})).status,200);
    assert.equal((await fetch(`${url}/jobs/${clip.id}`,{headers})).status,410);
    console.log(`YouTube passed: ${source.name}, ${source.media.duration}s source, only selected 10–22s analyzed (${clip.duration}s)`);
  } else {
    const rate = 32000, duration = 24, samples = rate * duration, wav = Buffer.alloc(44 + samples * 4);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 4, 40);
    for (let i = 0; i < samples; i++) { const t = i / rate, hz = t < 8 ? 110 : t < 20 ? 170 : 230, value = Math.round(Math.sin(2 * Math.PI * hz * t) * 18000); wav.writeInt16LE(value, 44 + 4 * i); wav.writeInt16LE(value, 46 + 4 * i); }
    const input = join(folder, "source.wav"); await writeFile(input, wav);
    const cases = [
      ["wav", "audio", ["-c:a", "pcm_s16le"]], ["mp3", "audio", ["-c:a", "libmp3lame"]], ["m4a", "audio", ["-c:a", "aac"]], ["aac", "audio", ["-c:a", "aac", "-f", "adts"]], ["flac", "audio", ["-c:a", "flac"]],
      ["ogg", "audio", ["-c:a", "libvorbis"]], ["opus", "audio", ["-c:a", "libopus", "-ar", "48000"]], ["aiff", "audio", ["-c:a", "pcm_s16be"]], ["wma", "audio", ["-c:a", "wmav2"]], ["caf", "audio", ["-c:a", "pcm_s16le"]], ["ac3", "audio", ["-c:a", "ac3", "-ar", "48000"]], ["mka", "audio", ["-c:a", "flac"]],
      ["mp4", "video", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]], ["mov", "video", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]], ["mkv", "video", ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "flac"]],
      ["webm", "video", ["-c:v", "libvpx", "-deadline", "realtime", "-c:a", "libvorbis"]], ["avi", "video", ["-c:v", "mpeg4", "-c:a", "pcm_s16le"]], ["wmv", "video", ["-c:v", "wmv2", "-c:a", "wmav2"]], ["flv", "video", ["-c:v", "flv", "-c:a", "libmp3lame", "-ar", "44100"]],
      ["mpeg", "video", ["-c:v", "mpeg2video", "-c:a", "mp2", "-ar", "48000", "-f", "mpeg"]], ["mts", "video", ["-c:v", "mpeg2video", "-c:a", "ac3", "-ar", "48000", "-f", "mpegts"]], ["m2ts", "video", ["-c:v", "mpeg2video", "-c:a", "ac3", "-ar", "48000", "-f", "mpegts"]],
      ["3gp", "video", ["-c:v", "mpeg4", "-c:a", "aac", "-ar", "16000", "-ac", "1"]], ["vob", "video", ["-c:v", "mpeg2video", "-c:a", "ac3", "-ar", "48000", "-f", "vob"]], ["ogv", "video", ["-c:v", "libtheora", "-c:a", "libvorbis"]],
    ];
    console.log(`Generating ${cases.length} audio/video fixtures`);
    for (let i = 0; i < cases.length; i += 3) {
      const results = await Promise.allSettled(cases.slice(i, i + 3).map(([ext, kind, codecs]) => command("ffmpeg", ["-v", "error", "-y", ...(kind === "video" ? ["-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=24"] : []), "-i", linuxPath(input), "-t", "24", "-threads", "2", ...codecs, linuxPath(join(folder, `sample.${ext}`))])));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
    for (const [ext, kind] of cases) {
      const source = await upload(`sample.${ext}`, join(folder, `sample.${ext}`)); assert.equal(source.state, "selecting", JSON.stringify(source)); assert.equal(source.media.kind, kind); assert.equal(source.events, undefined);
      await checkPreview(await select(source)); console.log(`${ext.toUpperCase()}: source inspected, exact 8–20s audio cut, C/speech pipeline and seekable WAV preview passed`);
    }
    const renamed = await upload("recording.unknown", input); assert.equal(renamed.state, "selecting"); assert.equal(renamed.media.kind, "audio");
    const silent = join(folder, "silent.mp4"); await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=s=160x120:r=5:d=10", "-an", "-c:v", "libx264", "-preset", "ultrafast", linuxPath(silent)]);
    const rejected = await upload("silent.mp4", silent); assert.equal(rejected.state, "error"); assert.match(rejected.error, /no audio track/);
    console.log("Content probing and no-audio rejection passed; filenames do not gate decoders");
  }
} finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await server.cleanup; }
