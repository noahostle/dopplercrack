// Browser searches use one automatic pipeline. Experimental CLI fixtures remain
// independent so historical numerical experiments can still be reproduced.
export function automaticSearchInput(job, input) {
  if (job.detectorVersion !== 4) throw new Error("Reanalyze this recording to use the updated audio detector.");
  if (!job.events?.length || !job.automaticMeasurements?.length) throw new Error("Insufficient aircraft-like signal. Try a longer continuous portion or another recording.");
  return {
    countries: input.countries, bounds: input.bounds, timeRange: input.timeRange,
    recordingStart:input.recordingStart,recordingOffsetSeconds:job.segment?.start||0,
    startUtc: input.startUtc, endUtc: input.endUtc,
    automatic: true, eventIds: job.events.map(event => event.id),
    eventMeasurements: job.automaticMeasurements, scoreMode: "spectral",
    terrainMode: "auto", silence: true, online: true, refine: true,
    gridKm: .2, timeStep: 1, threads: 0, temperature: 15, receiverAltitude: 0,
  };
}

export function resultLeaderboard(result, limit = 10) {
  const groups = new Map();
  const rows = [...(result.flightLeaders || []), ...(result.candidates || [])];
  const rank=row=>row.rankLoss??(Number.isFinite(row.score)?-row.score:row.loss);
  rows.sort((a,b) => rank(a)-rank(b) || a.clock-b.clock);
  for (const row of rows) {
    // Flight IDs can repeat across dates. Keep distinct recording-day explanations.
    const key = `${row.flights.join("+")}:${Math.floor(row.clock / 86400)}`;
    if (!groups.has(key)) groups.set(key, row);
  }
  return [...groups.values()].slice(0, limit);
}
