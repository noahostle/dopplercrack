import test from 'node:test';
import assert from 'node:assert/strict';
import {localRecordingTime, applyRecordingMetadata, archiveLocalWindow} from '../lib/doppler-clock.mjs';
import {parseSpectrum, spectrumBounds, spectrumPixels} from '../lib/doppler-spectrum.mjs';
import {placeIndex, nearestPlace, lookupPlaces} from './doppler-places.mjs';

test('UTC metadata is displayed in the selected zone across local midnight and DST', () => {
  assert.deepEqual(localRecordingTime('2026-10-26T23:59:00Z', 'Australia/Sydney'), {date:'2026-10-27', time:'10:59:00'});
  assert.deepEqual(localRecordingTime('2026-01-01T02:00:00Z', 'America/Los_Angeles'), {date:'2025-12-31', time:'18:00:00'});
  assert.equal(localRecordingTime('2026-10-03T15:59:00Z', 'Australia/Sydney').time, '01:59:00');
  assert.equal(localRecordingTime('2026-10-03T16:00:00Z', 'Australia/Sydney').time, '03:00:00');
});
test('Embedded clocks preserve timezone and previously entered fields', () => {
  const range = {dateFrom:'', timeFrom:'', timeZone:'Australia/Sydney', mode:'exact'};
  const filled = applyRecordingMetadata(range, {utc:'2026-10-26T23:59:00Z'});
  assert.equal(filled.timeZone, 'Australia/Sydney'); assert.equal(filled.dateFrom, '2026-10-27'); assert.equal(filled.timeFrom, '10:59:00');
  for (const metadata of [{utc:'2020-01-01T00:00:00Z'}, {local:'2020-01-01T04:00:00'}, {date:'2020-01-01'}]) assert.equal(applyRecordingMetadata(filled, metadata), filled);
  assert.equal(applyRecordingMetadata(range, {utc:'invalid'}), range);
  const window = archiveLocalWindow('2026-10-26', 'Australia/Sydney'); assert.match(window, /26/); assert.match(window, /27/); assert.match(window, /11:00/);
});
function fixture() {
  const nt = 17, nf = 3541, buffer = new ArrayBuffer(64 + nt*nf), view = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode('SGSPEC3')); view.setUint32(8, nt, true); view.setUint32(12, nf, true);
  for (const [offset, value] of [[16,0],[24,.5],[32,15],[40,.25],[48,8],[56,1]]) view.setFloat64(offset,value,true);
  new Uint8Array(buffer,64)[8*nf+340] = 40;
  return buffer;
}
test('Spectrogram uses worker frequency/time units and preserves a narrow ridge while downsampling', () => {
  const spectrum = parseSpectrum(fixture()); assert.equal(spectrum.values[8*3541+340],40);
  const bounds = spectrumBounds(spectrum, []), pixels = spectrumPixels(spectrum,bounds,8,10,40);
  assert.equal(bounds.high,900); assert.equal(bounds.low,15); assert.equal(bounds.end,8);
  const offset=(9*8+4)*4; assert.deepEqual([...pixels.slice(offset,offset+4)],[255,247,218,255]);
  assert.deepEqual([...pixels.slice(0,4)],[9,21,28,255]);
  const events=[{id:1,points:[[2,110],[6,100]]}];const focus=spectrumBounds(spectrum,events,1);
  assert.ok(focus.low <100 && focus.high >110);assert.deepEqual(spectrumBounds(spectrum,events,'full'),bounds);
});
test('Malformed or truncated spectra fail explicitly', () => {
  assert.throws(()=>parseSpectrum(new ArrayBuffer(2)),/Incomplete/);
  const invalid=fixture();new DataView(invalid).setFloat64(56,0,true);assert.throws(()=>parseSpectrum(invalid),/Invalid/);
  assert.throws(()=>parseSpectrum(fixture().slice(0,-1)),/Invalid/);
});
test('Offline labels include region and country, handle the dateline and do not cross borders', () => {
  const world=[{code:'AU',name:'Australia'},{code:'NZ',name:'New Zealand'}];
  const index=placeIndex({admins:{'AU.02':'New South Wales','NZ.01':'Auckland'},cities:[['Sydney',-33.86,151.2,'AU','02'],['Near border',-33.86,151.201,'NZ','01'],['Dateline town',0,-179.99,'AU','02']]});
  assert.equal(nearestPlace({lat:-33.86,lon:151.201,country:'AU'},index,world).label,'Sydney, New South Wales, Australia');
  const wrapped=nearestPlace({lat:0,lon:179.99,country:'AU'},index,world);assert.equal(wrapped.city,'Dateline town');assert.ok(wrapped.distanceKm<3);
  assert.equal(nearestPlace({lat:0,lon:0,country:'AU'},index,world).label,'Australia');
});
test('Place lookup rejects invalid and oversized requests', async () => {
  for(const points of [[],Array(12).fill({lat:0,lon:0}),[{lat:91,lon:0}],[{lat:'0',lon:0}],[{lat:0,lon:0,country:'arbitrary'}]]) await assert.rejects(()=>lookupPlaces(points),/valid latitude/);
});
