/**
 * UC-3 Marine sea-channel connector — JNPA channel polygons (GeoJSON, WGS84).
 *
 * Reads `/api/marine/sea-channels*` and maps the gateway's wire rows onto the UC-1 domain
 * type. Structured like portCraft.ts / pilotage.ts: endpoint constants, a typed *wire*
 * interface, exported PURE mappers, I/O last — unit-testable with no network.
 *
 * Backing store: `core.sea_channel`, populated by the SHARED marine upload endpoints
 * (`/api/marine/upload`) when the JNPA_Sea_Channels shapefile ZIP is uploaded. Geometry
 * is GeoJSON reprojected to WGS84 (EPSG:4326) at parse time — ready to draw on a map.
 */

import type { SeaChannel } from '@/types/domain';
import { http } from './client';

export const SEA_CHANNEL_PATH = '/marine/sea-channels';
export const SEA_CHANNEL_GEOJSON_PATH = '/marine/sea-channels/geojson';
export const SEA_CHANNEL_PAGE_LIMIT = 200;

/** A GeoJSON Polygon geometry (WGS84 lon/lat). */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

/** One channel row exactly as the gateway returns it. Snake_case wire shape. */
export interface SeaChannelWire {
  channel_id: number | null;
  name: string | null;
  section_label: string | null;
  area_ha: number | null;
  length_m: number | null;
  geom_geojson: GeoJsonPolygon | null;
  import_file_id: number | null;
}

export interface SeaChannelPage {
  items: SeaChannelWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/** GeoJSON FeatureCollection returned by /sea-channels/geojson. */
export interface SeaChannelFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: GeoJsonPolygon | null;
    properties: Record<string, unknown>;
  }[];
  count: number;
}

export interface SeaChannelFilters {
  name?: string;
  section?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}
function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map one wire row onto the domain type. Pure. Drops a row with no `channel_id`. */
export function mapSeaChannel(w: SeaChannelWire): SeaChannel | null {
  const channelId = nullableNum(w?.channel_id);
  if (channelId === null) return null;
  const g = w.geom_geojson;
  return {
    channelId,
    name: str(w.name),
    sectionLabel: str(w.section_label),
    areaHa: nullableNum(w.area_ha),
    lengthM: nullableNum(w.length_m),
    geometry: (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) ? g : null,
  };
}

/** Map a whole page, dropping unusable rows, preserving server order. Pure, tolerant. */
export function parseSeaChannelPage(raw: unknown): SeaChannel[] {
  const items = (raw as SeaChannelPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapSeaChannel).filter((c): c is SeaChannel => c !== null);
}

/** Build the query string. Pure. */
export function seaChannelQuery(
  filters: SeaChannelFilters = {},
  limit = SEA_CHANNEL_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
  };
  put('name', filters.name);
  put('section', filters.section);
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${SEA_CHANNEL_PATH}?${q.toString()}`;
}

/** Fetch the channel list (small — 50 rows — so one page suffices). */
export async function fetchSeaChannels(
  filters: SeaChannelFilters = {},
  limit = SEA_CHANNEL_PAGE_LIMIT,
  offset = 0,
): Promise<SeaChannel[]> {
  const page = await http<SeaChannelPage>(seaChannelQuery(filters, limit, offset));
  return parseSeaChannelPage(page);
}

/** Fetch the WGS84 GeoJSON FeatureCollection for a map overlay. */
export async function fetchSeaChannelGeojson(): Promise<SeaChannelFeatureCollection> {
  const fc = await http<SeaChannelFeatureCollection>(`${SEA_CHANNEL_GEOJSON_PATH}?limit=500`);
  return (fc && fc.type === 'FeatureCollection' && Array.isArray(fc.features))
    ? fc
    : { type: 'FeatureCollection', features: [], count: 0 };
}
