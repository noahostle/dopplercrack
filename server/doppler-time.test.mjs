import test from "node:test";
import assert from "node:assert/strict";
import { recordingTimeFromMetadata, buildClockPlan, clockBatches, clockCount } from "./doppler-time.mjs";
import { mergeCandidates } from "./doppler-runner.mjs";
const now = Date.parse("2026-11-05T12:00:00Z") / 1000;

test("Recording metadata prefers original recording tags, normalizes offsets, and exposes conflicts", () => {
  const result = recordingTimeFromMetadata({ format: { tags: { creation_time: "2026-01-05T00:00:00Z", upload_date: "20260104" } }, streams: [{ codec_type: "video", tags: { date_time_original: "2026:01:01 11:00:00+1100" } }] }, now);
  assert.equal(result.utc, "2026-01-01T00:00:00.000Z"); assert.match(result.source, /video stream 0/);
  assert.equal(result.candidates.length, 2); assert.ok(result.warnings.some(warning => /disagree/.test(warning)));
  const quicktime = recordingTimeFromMetadata({ format: { tags: { "com.apple.quicktime.creationdate": "2026-01-01T09:00:00-05:00" } } }, now);
  assert.equal(quicktime.utc, "2026-01-01T14:00:00.000Z");
});
test("Naive, date-only, absent and invalid metadata never invent recording clocks", () => {
  const naive = recordingTimeFromMetadata({ format: { tags: { creation_time: "2026-01-01T11:00:00" } } }, now);
  assert.equal(naive.utc, undefined); assert.equal(naive.local, "2026-01-01T11:00:00"); assert.match(naive.warnings.join(" "), /no timezone/);
  const date = recordingTimeFromMetadata({ format: { tags: { date: "2026-01-01" } } }, now);
  assert.equal(date.date, "2026-01-01"); assert.equal(date.utc, undefined);
  for (const tags of [{ upload_date: "20260101", publish_time: "2026-01-01T00:00:00Z" }, { creation_time: "1904-01-01T00:00:00Z" }, { creation_time: "2026-02-30T00:00:00Z" }, {}]) assert.equal(recordingTimeFromMetadata({ format: { tags } }, now).candidates.length, 0);
});
test("Estimated dates search the requested time on every day, including overnight windows and every archive day", () => {
  const plan = buildClockPlan({ timeRange: { dateFrom: "2026-01-01", dateTo: "2026-01-03", timeFrom: "23:59:00", timeTo: "00:01:00" }, timeStep: 2 }, 100, now);
  assert.equal(plan.windowCount, 3); assert.equal(plan.clockTrials, 3 * 61);
  assert.deepEqual(plan.archiveDays, ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
  assert.equal(new Date(plan.windows[1].start * 1000).toISOString(), "2026-01-02T23:59:00.000Z");
  assert.equal(new Date(plan.windows[1].end * 1000).toISOString(), "2026-01-03T00:01:00.000Z");
});
test("C batches preserve all clock trials without duplicate boundaries or silent coarsening", () => {
  for (const step of [.5, 1, 2.5, 3600]) {
    const plan = buildClockPlan({ startUtc: "2026-01-01T10:11:12Z", endUtc: "2026-01-03T10:11:17Z", timeStep: step }, 30, now);
    const batches = plan.windows.flatMap(window => clockBatches(window, step));
    assert.equal(batches.length, plan.batchCount); assert.equal(batches.reduce((sum, batch) => sum + clockCount(batch, step), 0), plan.clockTrials);
    for (let i = 0; i < batches.length; i++) {
      assert.ok(clockCount(batches[i], step) <= 720); assert.ok(batches[i].end - batches[i].start <= 10800);
      if (i) assert.ok(Math.abs(batches[i].start - batches[i - 1].end - step) < .0001);
    }
    assert.equal(plan.clockTrials, Math.floor((172800 + 5) / step) + 1);
  }
});
test("Range validation limits dates, rejects missing estimates, and clips future times explicitly", () => {
  const input = { timeRange: { dateFrom: "2026-01-01", dateTo: "2026-01-02", timeFrom: "12:00", timeTo: "13:00" }, timeStep: 1 };
  assert.throws(() => buildClockPlan({ ...input, timeRange: { ...input.timeRange, dateFrom: "2026-02-30" } }, 100, now), /Invalid estimated date/);
  assert.throws(() => buildClockPlan({ ...input, timeRange: { ...input.timeRange, timeFrom: "" } }, 100, now), /estimated time/);
  assert.throws(() => buildClockPlan({ ...input, timeRange: { ...input.timeRange, dateTo: "2027-01-02" } }, 100, now), /366/);
  assert.throws(() => buildClockPlan({ startUtc: "2026-01-01T00:00:00", endUtc: "2026-01-01T00:00:00", timeStep: 1 }, 100, now), /UTC/);
  const clipped = buildClockPlan({ ...input, timeRange: { ...input.timeRange, dateFrom: "2026-11-05", dateTo: "2026-11-06", timeFrom: "00:00", timeTo: "23:59:59" } }, 100, now);
  assert.equal(clipped.windowCount, 1); assert.equal(clipped.end, now); assert.equal(clipped.clippedFuture, true);
});
test("Cross-date candidate merging retains the best fit and its actual UTC clock", () => {
  const old = { lat: -33, lon: 151, loss: .02, clock: 100, flights: ["old"] }, best = { ...old, loss: .01, clock: 86500, flights: ["best"] };
  assert.deepEqual(mergeCandidates([old], [best])[0], best);
});
