import "server-only";
import { geoMercator, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import sharp from "sharp";
import countries from "world-atlas/countries-50m.json";

/**
 * ADR-051: a slide that names places gets a real map drawn by code, not a landscape
 * picture. The image has no text; the Ukrainian place names are added by the slide
 * layout next to the markers, so they stay correct and editable.
 */
export interface MapPlace { name: string; lat: number; lon: number }
export interface MapLabel { name: string; x: number; y: number }

export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 1000;
const PADDING = 90;
/** Smallest shown area in degrees, so one city still shows its country and sea. */
const MIN_SPAN = 9;

export function validPlaces(places: MapPlace[] | undefined) {
  return (places ?? []).filter(p => p.name.trim() && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 80 && Math.abs(p.lon) <= 180).slice(0, 8);
}

function frame(places: MapPlace[]) {
  const lats = places.map(p => p.lat), lons = places.map(p => p.lon);
  let [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const grow = (low: number, high: number, min: number): [number, number] => {
    const span = Math.max(high - low, min) * 1.35;
    const middle = (low + high) / 2;
    return [middle - span / 2, middle + span / 2];
  };
  [south, north] = grow(south, north, MIN_SPAN * 0.75);
  [west, east] = grow(west, east, MIN_SPAN);
  return { type: "Feature" as const, properties: {}, geometry: { type: "MultiPoint" as const, coordinates: [[west, south], [east, south], [west, north], [east, north]] } };
}

/** Renders the map as a JPEG and returns where each place lands (0–1 of width and height). */
export async function renderPlaceMap(input: MapPlace[]): Promise<{ bytes: Buffer; labels: MapLabel[] }> {
  const places = validPlaces(input);
  if (!places.length) throw new Error("Немає місць для карти.");
  const projection = geoMercator().fitExtent([[PADDING, PADDING], [MAP_WIDTH - PADDING, MAP_HEIGHT - PADDING]], frame(places));
  const path = geoPath(projection);
  const topology = countries as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
  const land = path(feature(topology, topology.objects.land)) ?? "";
  const borders = path(mesh(topology, topology.objects.countries, (a, b) => a !== b)) ?? "";
  const labels = places.map(place => {
    const [x, y] = projection([place.lon, place.lat]) ?? [MAP_WIDTH / 2, MAP_HEIGHT / 2];
    return { name: place.name.trim().slice(0, 40), x: x / MAP_WIDTH, y: y / MAP_HEIGHT };
  });
  const markers = labels.map(l => `<circle cx="${(l.x * MAP_WIDTH).toFixed(1)}" cy="${(l.y * MAP_HEIGHT).toFixed(1)}" r="13" fill="#FF7A50" stroke="#FFFFFF" stroke-width="5"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}">
<rect width="100%" height="100%" fill="#BFDDE6"/>
<path d="${land}" fill="#F1E7CF" stroke="#7E9A9E" stroke-width="1.6" stroke-linejoin="round"/>
<path d="${borders}" fill="none" stroke="#B8A98A" stroke-width="1.2" stroke-dasharray="5 4"/>
${markers}
</svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
  return { bytes, labels };
}
