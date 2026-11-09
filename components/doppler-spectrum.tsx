import {useEffect, useMemo, useRef, useState} from 'react';
import {AudioLines, LoaderCircle} from 'lucide-react';
import {parseSpectrum, spectrumBounds, spectrumPixels} from '../lib/doppler-spectrum.mjs';
import {mediaTime} from '../lib/doppler-media.mjs';
import type {DopplerEvent, DopplerJob} from '../lib/doppler-types';

const colors = ['#fd8f6b', '#8cdfff', '#e5d77c', '#b2e6a1', '#e6b7f8', '#8ae0cc', '#f8aed1', '#dce8f2'];
const emptyEvents:DopplerEvent[] = [];
type Spectrum = ReturnType<typeof parseSpectrum>;
export function DopplerSpectrum({job}: {job: DopplerJob}) {
  const [spectrum, setSpectrum] = useState<Spectrum>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<number|'full'|null>(null), [curves, setCurves] = useState(true), [ceiling, setCeiling] = useState(35);
  const [width, setWidth] = useState(800), [hover, setHover] = useState('');
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const events = job.events || emptyEvents, height = 310, left = 48, right = 16, top = 16, bottom = 38;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  useEffect(() => {
    const controller = new AbortController(); setSpectrum(undefined); setError('');
    void fetch(`/api/doppler?job=${job.id}&action=spectrum`, {cache:'no-store', signal: controller.signal})
      .then(async response => {if (!response.ok) throw new Error('Spectrogram unavailable for this session'); return parseSpectrum(await response.arrayBuffer());})
      .then(setSpectrum).catch(error => {if (!controller.signal.aborted) setError(error.message);});
    return () => controller.abort();
  }, [job.id, retry]);
  useEffect(() => {
    if (!container.current) return;
    const resize = new ResizeObserver(entries => setWidth(Math.max(200, Math.floor(entries[0].contentRect.width))));
    resize.observe(container.current); return () => resize.disconnect();
  }, []);
  const bounds = useMemo(() => spectrum ? spectrumBounds(spectrum, events, selected) : undefined, [spectrum, events, selected]);
  useEffect(() => {
    if (!spectrum || !bounds || !canvas.current) return;
    const context = canvas.current.getContext('2d'); if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.current.width = Math.round(width * ratio); canvas.current.height = height * ratio;
    context.scale(ratio, ratio); context.fillStyle = '#101e26'; context.fillRect(0, 0, width, height);
    const raster = document.createElement('canvas'); raster.width = plotWidth; raster.height = plotHeight;
    raster.getContext('2d')!.putImageData(new ImageData(spectrumPixels(spectrum, bounds, plotWidth, plotHeight, ceiling), plotWidth, plotHeight), 0, 0);
    context.imageSmoothingEnabled = false; context.drawImage(raster, left, top);
    context.font = '10px ui-monospace, monospace'; context.fillStyle = '#b5c5c7'; context.strokeStyle = '#ccddd51c'; context.lineWidth = 1;
    const ticks = plotWidth < 360 ? 2 : 4;
    for (let i = 0; i <= 4; i++) {
      const y = top + plotHeight * i/4; context.textAlign = 'right'; context.fillText(String(Math.round(bounds.high - (bounds.high-bounds.low) * i/4)), left-8, y+3);
      context.beginPath(); context.moveTo(left, y); context.lineTo(width-right, y); context.stroke();
    }
    for (let i = 0; i <= ticks; i++) {const x = left + plotWidth * i/ticks; context.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center'; context.fillText(mediaTime(bounds.start + (bounds.end-bounds.start)*i/ticks), x, height-18);}
    context.fillStyle = '#899fa4'; context.textAlign = 'left'; context.fillText('Hz', 9, 12); context.textAlign = 'right'; context.fillText('CLIP TIME', width-right, height-4);
    if (!curves) return;
    context.save(); context.beginPath(); context.rect(left, top, plotWidth, plotHeight); context.clip();
    events.forEach((event: DopplerEvent, index: number) => {
      if (typeof selected === 'number' && event.id !== selected) return;
      const points = event.points.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (!points.length) return;
      const draw = () => {context.beginPath(); points.forEach(([t, f], i) => {const x = left+(t-bounds.start)/(bounds.end-bounds.start)*plotWidth, y = top+(bounds.high-f)/(bounds.high-bounds.low)*plotHeight; if (i) context.lineTo(x,y); else context.moveTo(x,y);}); context.stroke();};
      context.lineJoin = 'round'; context.lineWidth = 4; context.strokeStyle = '#061219c0'; draw();
      context.lineWidth = 1.6; context.strokeStyle = colors[index % colors.length]; draw();
      const [t, f] = points[Math.floor(points.length/2)]; context.fillStyle = colors[index % colors.length]; context.textAlign = 'center';
      context.fillText(`C${event.id}`, left+(t-bounds.start)/(bounds.end-bounds.start)*plotWidth, top+(bounds.high-f)/(bounds.high-bounds.low)*plotHeight-8);
    });
    context.restore();
  }, [spectrum, bounds, width, plotWidth, curves, ceiling, events, selected]);
  return <section className="dc-panel dc-signal"><h2><AudioLines size={16}/> Signal analysis <small>{events.length} detected curve{events.length === 1 ? '' : 's'}</small></h2>
    <div className="dc-signal-controls"><div className="dc-signal-tabs" aria-label="Spectrogram view"><button className={selected === null ? 'active' : ''} aria-pressed={selected === null} onClick={() => setSelected(null)}>Detected band</button><button className={selected === 'full' ? 'active' : ''} aria-pressed={selected === 'full'} onClick={() => setSelected('full')}>Full spectrum</button></div><label><input type="checkbox" checked={curves} onChange={e => setCurves(e.target.checked)}/> Show curves</label></div>
    <div className="dc-spectrum" ref={container}>{spectrum ? <canvas ref={canvas} style={{height}} role="img" aria-label={`Audio spectrogram with ${events.length} detected Doppler curves. Horizontal axis: seconds into selected clip. Vertical axis: frequency in hertz.`} onPointerLeave={() => setHover('')} onPointerMove={e => {if (!bounds) return; const box = e.currentTarget.getBoundingClientRect(), x = e.clientX-box.left-left, y = e.clientY-box.top-top; if (x<0||x>plotWidth||y<0||y>plotHeight) return setHover(''); const time = bounds.start+x/plotWidth*(bounds.end-bounds.start), hz = bounds.high-y/plotHeight*(bounds.high-bounds.low); setHover(`${time.toFixed(1)} s · ${hz.toFixed(1)} Hz${job.segment?.start ? ` · source ${mediaTime(job.segment.start+time)}` : ''}`);}}/> : <div className="dc-spectrum-loading" role="status">{error ? <>{error}<button onClick={() => setRetry(value => value+1)}>Retry</button></> : <><LoaderCircle size={18} className="spin"/> Loading spectrogram…</>}</div>}</div>
    <div className="dc-spectrum-meta"><span>{hover}</span><label>Contrast<input aria-label="Spectrogram contrast" type="range" min="15" max="65" step="5" value={80-ceiling} onChange={e => setCeiling(80-Number(e.target.value))}/></label></div>
    {!!events.length && <div className="dc-curves">{events.map((event, index) => <button key={event.id} className={selected === event.id ? 'active' : ''} aria-pressed={selected === event.id} onClick={() => setSelected(selected === event.id ? null : event.id)}><i style={{background: colors[index%colors.length]}}/><strong>Curve {event.id}</strong><span>{mediaTime(event.start)}–{mediaTime(event.end)}</span><small>{event.points[0]?.[1].toFixed(1)} → {event.points.at(-1)?.[1].toFixed(1)} Hz</small></button>)}</div>}
    {!events.length&&<p className="dc-note">{job.state === 'analyzing' ? 'The detector is checking this audio for moving tones.' : 'No coherent Doppler curve was retained in this portion.'}</p>}
  </section>;
}
