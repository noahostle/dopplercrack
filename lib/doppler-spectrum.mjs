// SGSPEC is the C worker's median-subtracted spectrum, not a second FFT.
export function parseSpectrum(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 64) throw new Error('Incomplete spectrogram');
  const view = new DataView(buffer), magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 7));
  const nt = view.getUint32(8, true), nf = view.getUint32(12, true);
  const t0 = view.getFloat64(16, true), dt = view.getFloat64(24, true), f0 = view.getFloat64(32, true), df = view.getFloat64(40, true), duration = view.getFloat64(48, true);
  const scale = magic === 'SGSPEC3' ? view.getFloat64(56, true) : 4;
  if (!['SGSPEC2', 'SGSPEC3'].includes(magic) || nt < 2 || nt > 3602 || nf !== 3541 || t0 !== 0 || dt !== .5 || f0 !== 15 || df !== .25 || !Number.isFinite(duration) || duration <= 0 || duration > 1800 || nt !== Math.ceil(duration * 2) + 1 || !Number.isFinite(scale) || scale <= 0 || buffer.byteLength !== 64 + nt * nf) throw new Error('Invalid spectrogram data');
  return {nt, nf, t0, dt, f0, df, duration, scale, values: new Uint8Array(buffer, 64)};
}

/** @param {number|'full'|null} selected */
export function spectrumBounds(spectrum, events, selected = null) {
  const chosen = selected === null ? events : events.filter(event => event.id === selected);
  const points = chosen.flatMap(event => event.points || []).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (!points.length || selected === 'full') return {start: 0, end: spectrum.duration, low: spectrum.f0, high: spectrum.f0 + (spectrum.nf - 1) * spectrum.df};
  let low = Infinity, high = -Infinity, start = Infinity, end = -Infinity;
  for (const [t, f] of points) {low = Math.min(low, f); high = Math.max(high, f); start = Math.min(start, t); end = Math.max(end, t);}
  const margin = Math.max(15, (high - low) * .35);
  return {start: selected === null ? 0 : Math.max(0, start - 4), end: selected === null ? spectrum.duration : Math.min(spectrum.duration, end + 4), low: Math.max(spectrum.f0, low - margin), high: Math.min(spectrum.f0 + (spectrum.nf - 1) * spectrum.df, high + margin)};
}

const stops = [[9, 21, 28], [21, 56, 69], [37, 108, 118], [122, 182, 165], [241, 212, 136], [255, 247, 218]];
export function spectrumPixels(spectrum, bounds, width, height, ceiling = 35) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const palette = Array.from({length: 256}, (_, value) => {
    const position = Math.min(1, value / spectrum.scale / ceiling) * (stops.length - 1), index = Math.min(stops.length - 2, Math.floor(position)), blend = position - index;
    return stops[index].map((channel, i) => Math.round(channel * (1 - blend) + stops[index + 1][i] * blend));
  });
  // Max pooling preserves narrow ridges when a long recording is downsampled.
  for (let x = 0; x < width; x++) {
    const t0 = Math.max(0, Math.floor((bounds.start + x / width * (bounds.end-bounds.start) - spectrum.t0) / spectrum.dt));
    const t1 = Math.min(spectrum.nt - 1, Math.max(t0, Math.ceil((bounds.start + (x+1) / width * (bounds.end-bounds.start) - spectrum.t0) / spectrum.dt) - 1));
    for (let y = 0; y < height; y++) {
      const f0 = Math.max(0, Math.floor((bounds.high - (y+1) / height * (bounds.high-bounds.low) - spectrum.f0) / spectrum.df));
      const f1 = Math.min(spectrum.nf - 1, Math.max(f0, Math.ceil((bounds.high - y / height * (bounds.high-bounds.low) - spectrum.f0) / spectrum.df) - 1));
      let value = 0;
      for (let t = t0; t <= t1; t++) for (let f = f0; f <= f1; f++) value = Math.max(value, spectrum.values[t*spectrum.nf+f]);
      const offset = (y * width + x) * 4, color = palette[value];
      pixels[offset] = color[0]; pixels[offset+1] = color[1]; pixels[offset+2] = color[2]; pixels[offset+3] = 255;
    }
  }
  return pixels;
}
