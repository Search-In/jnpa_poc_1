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

/** Nhava Sheva approaches bounding box: [[swLat, swLon], [neLat, neLon]]. */
export const JNPA_BBOX: number[][] = [
  [18.85, 72.85],
  [19.05, 73.05],
];

export interface AisStreamOptions {
  token: string;
  onVessel: (v: Vessel) => void;
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
 * Map an AISStream message to a partial Vessel. Returns null for message types
 * we don't track. Static data (names/types) arrives separately from position,
 * so callers should merge by MMSI (the ArcGISAdapter keeps a per-MMSI cache).
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

  const ts = md.time_utc ? Date.parse(md.time_utc) : Date.now();
  return {
    MMSI: String(md.MMSI),
    VESSEL_NAME: (md.ShipName ?? '').trim() || `MMSI ${md.MMSI}`,
    VESSEL_TYPE: 'Unknown',
    NAV_STATUS: mapNavStatus(pr.NavigationalStatus),
    SOG: pr.Sog ?? 0,
    COG: pr.Cog ?? 0,
    HEADING: pr.TrueHeading ?? pr.Cog ?? 0,
    LAT: pr.Latitude ?? md.latitude ?? 0,
    LON: pr.Longitude ?? md.longitude ?? 0,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: Number.isNaN(ts) ? Date.now() : ts,
  };
}

/** Open the stream; returns an unsubscribe that closes the socket. */
export function openAisStream(opts: AisStreamOptions): () => void {
  const ws = new WebSocket(AISSTREAM_URL);
  const bbox = opts.bbox ?? JNPA_BBOX;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        APIKey: opts.token,
        BoundingBoxes: [bbox],
        FilterMessageTypes: ['PositionReport'],
      })
    );
    opts.onState?.('connected');
  };
  ws.onmessage = (event) => {
    try {
      const vessel = mapAisMessage(JSON.parse(event.data as string));
      if (vessel) opts.onVessel(vessel);
    } catch {
      // Ignore malformed frames; the stream is best-effort.
    }
  };
  ws.onerror = () => opts.onState?.('error');
  ws.onclose = () => opts.onState?.('closed');

  return () => ws.close();
}
