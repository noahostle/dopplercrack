export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function localRecordingTime(instant, timeZone = browserTimeZone()) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`};
}

export function applyRecordingMetadata(range, metadata) {
  // Embedded UTC is an instant, not a reason to change the user's timezone.
  // Preserve explicitly entered fields, including across recording replacement.
  const clock = metadata?.utc ? localRecordingTime(metadata.utc, range.timeZone)
    : metadata?.local ? {date: metadata.local.slice(0, 10), time: metadata.local.slice(11, 19)}
    : metadata?.date ? {date: metadata.date, time: ''} : null;
  if (!clock || range.dateFrom || range.timeFrom) return range;
  return {...range, dateFrom: clock.date, dateTo: clock.date, timeFrom: clock.time, timeTo: clock.time};
}

export function formatRecordingClock(seconds, timeZone) {
  return new Intl.DateTimeFormat(undefined, {timeZone, dateStyle: 'medium', timeStyle: 'medium'}).format(new Date(seconds * 1000));
}

export function archiveLocalWindow(day, timeZone) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const format = new Intl.DateTimeFormat(undefined, {timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'});
  return `${format.format(start)} – ${format.format(start + 86400000 - 1)}`;
}
