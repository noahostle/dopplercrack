import test from "node:test";
import assert from "node:assert/strict";
import { inspectMedia, inspectOnlineMedia, validateSegment, shiftRecordingTime, onlineInspectArgs, onlineClipArgs, publicMediaUrl, byteRange } from "./doppler-media.mjs";
import { DOPPLER_MEDIA_ACCEPT, parseMediaTime, mediaTime, youtubeId } from "../lib/doppler-media.mjs";

test("Source probing distinguishes audio with cover art, video, default audio tracks and missing durations", () => {
  const audio = { index: 2, codec_type: "audio", codec_name: "flac", duration_ts: 480000, time_base: "1/48000", channels: 2 };
  const descriptor = inspectMedia({ streams: [{ codec_type: "video", disposition: { attached_pic: 1 } }, audio] });
  assert.equal(descriptor.kind, "audio"); assert.equal(descriptor.duration, 10); assert.equal(descriptor.defaultAudioStream, 2);
  const video = inspectMedia({ format: { duration: "3600" }, streams: [{ codec_type: "video" }, audio, { ...audio, index: 3, disposition: { default: 1 }, tags: { language: "en" } }] });
  assert.equal(video.kind, "video"); assert.equal(video.duration, 3600); assert.equal(video.defaultAudioStream, 3);
  assert.equal(inspectMedia({ streams: [{ ...audio, duration_ts: undefined }] }).duration, undefined);
  assert.throws(() => inspectMedia({ streams: [{ codec_type: "video" }] }), /no audio track/);
});
test("A clip is required and bounded independently of long-source duration and audio-track choice", () => {
  const media = { duration: 7200, defaultAudioStream: 2, audioTracks: [{ index: 2 }, { index: 3 }] };
  assert.deepEqual(validateSegment({ start: 3600.25, end: 3660.25, audioStream: 3 }, media), { start: 3600.25, end: 3660.25, audioStream: 3 });
  for (const segment of [null, {}, { start: null, end: 10 }, { start: "", end: 10 }, { start: -1, end: 10 }, { start: 0, end: 7 }, { start: 0, end: 1801 }, { start: 7199, end: 7210 }, { start: 5, end: 4 }, { start: 0, end: 10, audioStream: 9 }]) assert.throws(() => validateSegment(segment, media));
});
test("Clip-relative metadata shifts across midnight without inventing a timezone or publication time", () => {
  const source = { utc: "2026-01-01T23:59:55Z", warnings: [], candidates: [] };
  const shifted = shiftRecordingTime(source, 10.5); assert.equal(shifted.utc, "2026-01-02T00:00:05.500Z"); assert.equal(shifted.sourceUtc, source.utc); assert.equal(source.warnings.length, 0);
  const naive = shiftRecordingTime({ local: "2026-01-01T23:59:55", warnings: [], candidates: [] }, 10);
  assert.equal(naive.utc, undefined); assert.equal(naive.local, "2026-01-02T00:00:05.000");
  assert.equal(shiftRecordingTime({ candidates: [], warnings: [] }, 100).utc, undefined);
});
test("Public URL intake probes first and builds a bounded yt-dlp section without cookies or playlists", () => {
  const url = "https://www.youtube.com/watch?v=BaW_jenozKc", inspect = onlineInspectArgs(url), clip = onlineClipArgs(url, { start: 10.5, end: 35.5 }, "/safe/media.%(ext)s");
  assert.ok(inspect.includes("--skip-download")); assert.ok(!inspect.includes("--download-sections"));
  assert.equal(clip[clip.indexOf("--download-sections") + 1], "*10.5-35.5"); assert.ok(clip.includes("--ignore-config")); assert.ok(clip.includes("--no-playlist"));
  assert.equal(clip[clip.indexOf("-f")+1],"bestaudio[protocol=https]/bestaudio");
  assert.ok(!clip.some(arg => /cookie/.test(arg))); assert.deepEqual(clip.slice(-2), ["--", url]);
  assert.equal(inspectOnlineMedia({ duration: 7200, extractor_key: "Youtube" }).duration, 7200);
  assert.throws(() => inspectOnlineMedia({ duration: 7200, is_live: true }), /live streams/);
  for (const bad of ["http://youtube.com/a", "https://youtube.com.evil.test/a", "https://localhost/a", "https://user:pass@youtube.com/a","https://vimeo.com/1234","https://x.com/user/status/1234","https://www.youtube.com/playlist?list=PL123"]) assert.throws(() => publicMediaUrl(bad));
  assert.equal(publicMediaUrl("https://m.youtube.com/watch?v=BaW_jenozKc&t=10"),url);
});
test("Audio/video picker and clip positions cover formats whose browser MIME type can be empty", () => {
  for (const ext of [".mp3", ".wav", ".m4a", ".aac", ".flac", ".aiff", ".wma", ".mkv", ".avi", ".mov", ".webm", ".m2ts", ".wmv", ".mxf"]) assert.ok(DOPPLER_MEDIA_ACCEPT.split(",").includes(ext));
  for (const [value, seconds] of [["12.5", 12.5], ["01:12.5", 72.5], ["01:02:03.125", 3723.125]]) { assert.equal(parseMediaTime(value), seconds); assert.equal(parseMediaTime(mediaTime(seconds)), seconds); }
  for (const value of ["", "1:60", "1.5:20", "nope", "-1"]) assert.ok(Number.isNaN(parseMediaTime(value)));
  assert.equal(youtubeId("https://youtu.be/BaW_jenozKc?t=10"), "BaW_jenozKc"); assert.equal(youtubeId("https://youtube.com/shorts/BaW_jenozKc"), "BaW_jenozKc"); assert.equal(youtubeId("https://youtube.com.evil.test/watch?v=BaW_jenozKc"), "");
});
test("Source/preview byte ranges support scrubbing and reject invalid or unsatisfiable ranges", () => {
  assert.deepEqual(byteRange("bytes=100-199", 1000), { start: 100, end: 199 }); assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 }); assert.deepEqual(byteRange("bytes=900-", 1000), { start: 900, end: 999 });
  for (const range of ["bytes=1000-", "bytes=2-1", "bytes=0-1,2-3", "bytes=-0", "bytes=-"]) assert.throws(() => byteRange(range, 1000));
});
