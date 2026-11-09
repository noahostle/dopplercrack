import {readFile} from 'node:fs/promises';
import {countries, insideCountry} from './doppler-data.mjs';

let gazetteer;
const radians = Math.PI / 180;

export function placeIndex(data) {
  const index = new Map();
  for (const [city, lat, lon, code, admin] of data.cities) {
    const latitude = lat * radians, longitude = lon * radians;
    const row = {city, state: data.admins[`${code}.${admin}`] || '', code,
      x: Math.cos(latitude) * Math.cos(longitude), y: Math.cos(latitude) * Math.sin(longitude), z: Math.sin(latitude)};
    if (!index.has(code)) index.set(code, []);
    index.get(code).push(row);
  }
  return index;
}

export function nearestPlace(point, index, world = countries) {
  const {lat, lon} = point;
  // Respect the search cell's country. Without one (e.g. a map click), use the
  // same country boundaries as the search, never a settlement across a border.
  const country = world.find(row => row.code === point.country) || world.find(row => insideCountry(lon, lat, row));
  if (!country) return null;
  const latitude = lat * radians, longitude = lon * radians;
  const x = Math.cos(latitude) * Math.cos(longitude), y = Math.cos(latitude) * Math.sin(longitude), z = Math.sin(latitude);
  let best, distance = Infinity;
  for (const row of index.get(country.code) || []) {
    const squared = (row.x-x)**2 + (row.y-y)**2 + (row.z-z)**2;
    if (squared < distance) {distance = squared; best = row;}
  }
  // A gazetteer supplies the nearest settlement, not a point-in-city assertion.
  // Do not attach a city hundreds of kilometres away to an offshore/rural cell.
  const distanceKm = 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(distance) / 2));
  if (!best || distanceKm > 100) return {country: country.name, countryCode: country.code, city: '', state: '', label: country.name};
  return {city: best.city, state: best.state, country: country.name, countryCode: country.code,
    label: [best.city, best.state, country.name].filter(Boolean).join(', '), distanceKm: Math.round(distanceKm * 10) / 10, approximate: true};
}

export async function lookupPlaces(points) {
  if (!Array.isArray(points) || points.length < 1 || points.length > 11 || points.some(p => !p || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90 || !Number.isFinite(p.lon) || Math.abs(p.lon) > 180 || p.country !== undefined && !/^[A-Z]{2}$/.test(p.country))) {
    throw new Error('Supply up to 11 valid latitude/longitude pairs');
  }
  gazetteer ||= readFile(new URL('../runtime/reference/places.json', import.meta.url), 'utf8').then(JSON.parse).then(placeIndex).catch(error => {gazetteer = undefined; throw error;});
  try {
    const index = await gazetteer;
    return {places: points.map(point => nearestPlace(point, index)), available: true};
  } catch {
    return {places: points.map(point => nearestPlace(point, new Map())), available: false};
  }
}
