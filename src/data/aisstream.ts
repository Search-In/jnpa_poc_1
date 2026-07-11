/**
 * Thin AISStream.io WebSocket connector (free, open-source AIS).
 *
 * Opens wss://stream.aisstream.io/v0/stream, subscribes to a JNPA / Nhava
 * Sheva bounding box, and maps PositionReport + ShipStaticData messages onto
 * domain `Vessel` records. Used as the live fallback when no Velocity Stream
 * Layer is configured. The same `Vessel` shape feeds the client-side
 * FeatureLayer feature-collection so identical map/KPI code runs either way.
 *
 * Docs: https://aisstream.io/documentation
 */

import type { NavStatus, Vessel } from '@/types/domain';
import type { ConnectionListener } from './types';

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';

/**
 * Default Nhava Sheva approaches box, [[swLat, swLon], [neLat, neLon]]. Used
 * only when no box is passed. NOTE: free public AIS (AISStream) currently has
 * no receiver coverage over Indian waters, so the live demo passes a
 * coverage-rich box from `env.liveRegion.bbox` (see src/data/config.ts).
 */
export const JNPA_BBOX: number[][] = [
  [18.85, 72.85],
  [19.05, 73.05],
];

export interface AisStreamOptions {
  token: string;
  onVessel: (v: Vessel) => void;
  /** Ship name/type from ShipStaticData, merged into the cache by MMSI. */
  onStatic?: (s: VesselStatic) => void;
  onState?: ConnectionListener;
  /** Override the bounding box (defaults to JNPA approaches). */
  bbox?: number[][];
}

/** AIS NavigationalStatus code → our NavStatus. (Subset; default underway.) */
export function mapNavStatus(code: number | undefined): NavStatus {
  switch (code) {
    case 1: // at anchor
      return 'anchored';
    case 5: // moored
      return 'moored';
    case 0: // under way using engine
    case 8: // under way sailing
      return 'underway';
    default:
      return 'underway';
  }
}

/**
 * AIS "Type of ship and cargo" code → a human VESSEL_TYPE the sprite registry
 * understands. Ranges follow the ITU-R M.1371 spec (the first digit is the
 * category). Returns 'Unknown' when not yet known (static data not yet seen).
 */
export function mapVesselType(code: number | undefined): string {
  if (code === undefined || code === 0) return 'Unknown';
  if (code === 50) return 'Pilot Vessel';
  if (code === 52) return 'Tug';
  if (code === 30) return 'Fishing';
  if (code === 31 || code === 32) return 'Tug'; // towing
  if (code >= 60 && code <= 69) return 'Passenger Ship';
  // 70–79 is "cargo" (AIS doesn't separate container vs general); in a container
  // port the overwhelming majority are container ships, so use that sprite.
  if (code >= 70 && code <= 79) return 'Container Ship';
  if (code >= 80 && code <= 89) return 'Tanker';
  if (code >= 40 && code <= 49) return 'High-Speed Craft';
  return 'Unknown';
}

/**
 * True when a lat/lon pair is a real, plottable WGS84 position. Rejects NaN,
 * out-of-range values, and the AIS "no fix" sentinel (0,0 — "null island" off
 * West Africa). A dropped position is safer than a fabricated one: rendering a
 * (0,0) ghost or an off-globe point silently corrupts the twin. This is the
 * hard integrity floor; richer sanity (teleport, land-mask, staleness) is a
 * separate data-quality pass.
 */
export function isPlottablePosition(lat: number | undefined, lon: number | undefined): boolean {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  // AIS transmits 0/0 when it has no positional fix; treat as "no position".
  if (lat === 0 && lon === 0) return false;
  return true;
}

/**
 * Map an AISStream message to a partial Vessel. Returns null for message types
 * we don't track, for missing MMSI, AND for reports with no valid position —
 * we never invent (0,0) coordinates. Static data (names/types) arrives
 * separately from position, so callers should merge by MMSI (the ArcGISAdapter
 * keeps a per-MMSI cache).
 */
export function mapAisMessage(msg: unknown): Vessel | null {
  const m = msg as {
    MessageType?: string;
    MetaData?: { MMSI?: number; ShipName?: string; latitude?: number; longitude?: number; time_utc?: string };
    Message?: {
      PositionReport?: {
        Sog?: number;
        Cog?: number;
        TrueHeading?: number;
        NavigationalStatus?: number;
        Latitude?: number;
        Longitude?: number;
      };
      ShipStaticData?: { Name?: string; Type?: number };
    };
  };
  if (m.MessageType !== 'PositionReport') return null;
  const pr = m.Message?.PositionReport;
  const md = m.MetaData;
  if (!pr || !md?.MMSI) return null;

  // Position may live on the report or in MetaData; require a real fix on one
  // of them. Drop the frame rather than plotting a fabricated (0,0) ghost.
  const lat = pr.Latitude ?? md.latitude;
  const lon = pr.Longitude ?? md.longitude;
  if (!isPlottablePosition(lat, lon)) return null;

  const ts = md.time_utc ? Date.parse(md.time_utc) : Date.now();
  return {
    MMSI: String(md.MMSI),
    VESSEL_NAME: (md.ShipName ?? '').trim() || `MMSI ${md.MMSI}`,
    VESSEL_TYPE: 'Unknown',
    NAV_STATUS: mapNavStatus(pr.NavigationalStatus),
    SOG: pr.Sog ?? 0,
    COG: pr.Cog ?? 0,
    HEADING: pr.TrueHeading ?? pr.Cog ?? 0,
    LAT: lat as number,
    LON: lon as number,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: Number.isNaN(ts) ? Date.now() : ts,
  };
}

/** Static-data update: ship name + type, keyed by MMSI, merged into the cache. */
export interface VesselStatic {
  MMSI: string;
  VESSEL_NAME: string;
  VESSEL_TYPE: string;
}

/**
 * Extract ship name + type from an AISStream `ShipStaticData` message (which
 * carries the AIS ship-type code that `PositionReport` lacks). Returns null for
 * other message types.
 */
export function mapStaticData(msg: unknown): VesselStatic | null {
  const m = msg as {
    MessageType?: string;
    MetaData?: { MMSI?: number; ShipName?: string };
    Message?: { ShipStaticData?: { Name?: string; Type?: number } };
  };
  if (m.MessageType !== 'ShipStaticData') return null;
  const sd = m.Message?.ShipStaticData;
  const md = m.MetaData;
  if (!sd || !md?.MMSI) return null;
  const name = (sd.Name ?? md.ShipName ?? '').trim();
  return {
    MMSI: String(md.MMSI),
    VESSEL_NAME: name || `MMSI ${md.MMSI}`,
    VESSEL_TYPE: mapVesselType(sd.Type),
  };
}

/** Open the stream; returns an unsubscribe that closes the socket. */
export function openAisStream(opts: AisStreamOptions): () => void {
  const ws = new WebSocket(AISSTREAM_URL);
  // AISStream pushes JSON, but browsers may deliver frames as Blob/ArrayBuffer
  // rather than string. Prefer arraybuffer so we can decode synchronously.
  ws.binaryType = 'arraybuffer';
  const bbox = opts.bbox ?? JNPA_BBOX;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        APIKey: opts.token,
        BoundingBoxes: [bbox],
        // Subscribe to BOTH: PositionReport gives live position; ShipStaticData
        // gives the ship name + type code (needed to pick the right sprite).
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      })
    );
    opts.onState?.('connected');
  };

  const handleText = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      const vessel = mapAisMessage(parsed);
      if (vessel) {
        opts.onVessel(vessel);
        return;
      }
      const stat = mapStaticData(parsed);
      if (stat) opts.onStatic?.(stat);
    } catch {
      // Ignore malformed frames; the stream is best-effort.
    }
  };

  ws.onmessage = (event) => {
    const data = event.data as string | ArrayBuffer | Blob;
    if (typeof data === 'string') {
      handleText(data);
    } else if (data instanceof ArrayBuffer) {
      handleText(new TextDecoder().decode(data));
    } else {
      // Blob fallback (some browsers ignore binaryType): decode asynchronously.
      void (data as Blob).text().then(handleText).catch(() => {});
    }
  };

  ws.onerror = () => opts.onState?.('error');
  ws.onclose = () => opts.onState?.('closed');

  return () => ws.close();
}
