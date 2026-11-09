import {useEffect, useState} from 'react';
import type {DopplerCandidate, DopplerPlace} from '../lib/doppler-types';
export const placeKey = (point: Pick<DopplerCandidate, 'lat'|'lon'>) => `${point.lat.toFixed(6)}:${point.lon.toFixed(6)}`;
export function useDopplerPlaces(candidates: DopplerCandidate[], chosen: DopplerCandidate|null) {
  const [places, setPlaces] = useState<Record<string, DopplerPlace|null>>({}), [available, setAvailable] = useState(true);
  const unique = new Map([...candidates, ...(chosen ? [chosen] : [])].map(point => [placeKey(point), {lat: point.lat, lon: point.lon, country: point.country}]));
  const key = JSON.stringify([...unique.values()].slice(0, 11));
  useEffect(() => {
    const points = JSON.parse(key); if (!points.length) return;
    const controller = new AbortController();
    void fetch('/api/doppler?action=places', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({points}), signal: controller.signal})
      .then(async response => {if (!response.ok) throw Error('Place lookup unavailable'); return response.json();})
      .then(data => {setAvailable(data.available); setPlaces(Object.fromEntries(points.map((point: DopplerCandidate, index: number) => [placeKey(point), data.places[index]])));})
      .catch(() => {if (!controller.signal.aborted) setAvailable(false);});
    return () => controller.abort();
  }, [key]);
  return {places, available};
}
