/**
 * JNPA / Nhava Sheva marine geography (spec §A5 data-realism). Terminal, vessel,
 * pilot and anchorage coordinates are now sourced from the SHARED, surveyed
 * `data/positions.json` (embedded from PoC_2 via the placement store), so UC-1
 * renders on exactly the same JNPA geography as UC-2 (audit F08: one geometry,
 * one naming convention across the suite).
 *
 * The approach channel is derived to thread the real terminal line up from the
 * pilot boarding ground / outer anchorage to the quay; depths are charted-datum
 * metres calibrated so deep-draft (BMCT/GTI-class) transits are genuinely tide-
 * gated — which is what makes the DUKC story defensible under evaluation.
 */
import { placementStore } from './placementStore';

export interface ChannelSegment {
  id: string;
  path: [number, number][];
  /** Charted depth below chart datum, metres (the DUKC "floor"). */
  chartedDepthM: number;
  name: string;
}

export interface AnchorageArea {
  id: string;
  name: string;
  ring: [number, number][];
}

export interface PilotStation {
  id: string;
  name: string;
  lng: number;
  lat: number;
}

export interface TerminalGeo {
  id: string;
  name: string;
  lng: number;
  lat: number;
  berths: number;
  /** Largest design draft the terminal handles, m. */
  maxDraftM: number;
}

/** Read a placement's [lng,lat] from the embedded positions.json, with fallback. */
function pos(key: string, fallback: [number, number]): [number, number] {
  const p = placementStore.get(key);
  return p ? [p.lng, p.lat] : fallback;
}

/**
 * Terminal metadata. Coordinates come from `terminal:<ID>` in positions.json
 * (derived from the surveyed asset clusters); berth counts + max design drafts
 * are the marine attributes UC-1 adds. Naming follows the shared convention
 * (NSICT / NSIGT / GTI / BMCT / JNPCT), matching the embedded data + UC-2.
 */
const TERMINAL_META: Array<{ id: string; name: string; berths: number; maxDraftM: number; fallback: [number, number] }> = [
  { id: 'NSICT', name: 'NSICT', berths: 3, maxDraftM: 15.0, fallback: [72.95259, 18.95879] },
  { id: 'NSIGT', name: 'NSIGT', berths: 2, maxDraftM: 14.5, fallback: [72.94971, 18.95395] },
  { id: 'GTI', name: 'GTI / APMT', berths: 2, maxDraftM: 16.5, fallback: [72.94572, 18.94553] },
  { id: 'BMCT', name: 'BMCT', berths: 4, maxDraftM: 16.5, fallback: [72.93892, 18.93839] },
  { id: 'JNPCT', name: 'JNPCT', berths: 2, maxDraftM: 13.5, fallback: [72.9335, 18.93015] },
];

export const TERMINALS: TerminalGeo[] = TERMINAL_META.map((t) => {
  const [lng, lat] = pos(`terminal:${t.id}`, t.fallback);
  return { id: t.id, name: t.name, lng, lat, berths: t.berths, maxDraftM: t.maxDraftM };
});

export const TERMINAL_BY_ID: Record<string, TerminalGeo> = Object.fromEntries(
  TERMINALS.map((t) => [t.id, t]),
);

/** Berthed-vessel spots from `vessel:<TERMINAL>` in positions.json. */
export const VESSEL_BERTH_POS: Record<string, [number, number]> = Object.fromEntries(
  TERMINAL_META.map((t) => [t.id, pos(`vessel:${t.id}`, [t.fallback[0] - 0.004, t.fallback[1] - 0.002])]),
);

/** Port centroid — camera home + the anchor for relative offsets. */
export const PORT_CENTER: [number, number] = (() => {
  const xs = TERMINALS.map((t) => t.lng);
  const ys = TERMINALS.map((t) => t.lat);
  return [xs.reduce((s, x) => s + x, 0) / xs.length, ys.reduce((s, y) => s + y, 0) / ys.length];
})();

/** Quay bearing (deg true) — water SW, land NE. */
export const QUAY_BEARING = 208;

/** Pilot boarding ground (`pilot:PBG`). */
const [pbgLng, pbgLat] = pos('pilot:PBG', [72.905, 18.918]);
export const PILOT_STATION: PilotStation = { id: 'PBG', name: 'Pilot Boarding Ground', lng: pbgLng, lat: pbgLat };

/** Anchorage centroids (`anchorage:OUTER` / `anchorage:WAIT`) → small rings. */
function ringAround(c: [number, number], w: number, h: number): [number, number][] {
  const [x, y] = c;
  return [
    [x - w, y - h],
    [x + w, y + h * 0.4],
    [x + w * 0.6, y + h],
    [x - w * 0.8, y + h * 0.5],
    [x - w, y - h],
  ];
}

const outerC = pos('anchorage:OUTER', [72.878, 18.898]);
const waitC = pos('anchorage:WAIT', [72.905, 18.912]);

export const ANCHORAGES: AnchorageArea[] = [
  { id: 'ANCH-OUTER', name: 'Outer anchorage', ring: ringAround(outerC, 0.02, 0.014) },
  { id: 'ANCH-WAIT', name: 'Waiting anchorage', ring: ringAround(waitC, 0.013, 0.01) },
];

/**
 * Approach channel, seaward → quay, as depth-graded segments threading from the
 * pilot boarding ground through the anchorages up to the terminal line. Depths
 * taper from the deep outer reach to the maintained inner channel; the inner
 * segments gate deep-draft vessels at low tide (the DUKC pinch points).
 */
const gti = TERMINAL_BY_ID['GTI'];
const bmct = TERMINAL_BY_ID['BMCT'];
export const CHANNEL: ChannelSegment[] = [
  { id: 'CH-OUTER', name: 'Outer approach', chartedDepthM: 17.5, path: [[outerC[0] - 0.01, outerC[1] - 0.008], outerC] },
  { id: 'CH-MID', name: 'Mid channel', chartedDepthM: 16.2, path: [outerC, waitC] },
  { id: 'CH-INNER', name: 'Inner channel (maintained)', chartedDepthM: 15.0, path: [waitC, [PILOT_STATION.lng, PILOT_STATION.lat]] },
  { id: 'CH-TURN', name: 'Turning basin', chartedDepthM: 15.5, path: [[PILOT_STATION.lng, PILOT_STATION.lat], [bmct.lng, bmct.lat]] },
  { id: 'CH-QUAY', name: 'Quay approach', chartedDepthM: 16.5, path: [[bmct.lng, bmct.lat], [gti.lng, gti.lat]] },
];

/** Full channel centreline (all segments joined) for a single flight path. */
export function channelCentreline(): [number, number][] {
  const pts: [number, number][] = [];
  for (const seg of CHANNEL) {
    for (const p of seg.path) {
      if (pts.length === 0 || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) {
        pts.push(p);
      }
    }
  }
  return pts;
}
