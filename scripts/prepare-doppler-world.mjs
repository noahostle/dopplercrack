// Regenerate the bundled selection map from public-domain country datasets.
import { mkdir, writeFile } from "node:fs/promises";
const sources = {
  countries: "https://raw.githubusercontent.com/mledoze/countries/master/countries.json",
  shapes: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
};
const [countries, shapes] = await Promise.all(Object.values(sources).map(async url => {
  const response = await fetch(url); if (!response.ok) throw new Error(`Dataset HTTP ${response.status}`); return response.json();
}));
function simplify(points, tolerance = .065) {
  if (points.length < 5) return points.map(p => p.map(n => +n.toFixed(3)));
  const end = points.length - 1, a = points[0], b = points[end];
  let max = 0, split = 0;
  for (let i = 1; i < end; i++) {
    const p = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    if (distance > max) { max = distance; split = i; }
  }
  if (max > tolerance) return [...simplify(points.slice(0, split + 1), tolerance).slice(0, -1), ...simplify(points.slice(split), tolerance)];
  return [a, b].map(p => p.map(n => +n.toFixed(3)));
}
const rows = countries.map(country => {
  const feature = shapes.features.find(f => [f.properties.ISO_A3, f.properties.ADM0_A3, f.properties.SOV_A3].includes(country.cca3));
  const geometry = feature?.geometry;
  const polygons = geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.type === "MultiPolygon" ? geometry.coordinates : [];
  return { code: country.cca2, name: country.name.common, region: country.region, subregion: country.subregion,
    languages: Object.values(country.languages || {}), center: country.latlng,
    polygons: polygons.map(polygon => polygon.map(ring => { const reduced = simplify(ring); return reduced.length >= 4 ? reduced : ring.map(p => p.map(n => +n.toFixed(3))); })) };
}).sort((a, b) => a.name.localeCompare(b.name));
const target = new URL("../public/doppler/", import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL("world.json", target), JSON.stringify(rows));
await writeFile(new URL("SOURCES.md", target), `Country names/languages: ${sources.countries} (CC0).\nBoundaries: ${sources.shapes} (Natural Earth public domain).\nSimplified for selection; boundaries are approximate and disputed areas follow the source.\n`);
console.log(`${rows.length} countries and territories; ${Buffer.byteLength(JSON.stringify(rows))} bytes`);
