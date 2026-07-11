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

// ---------------------------------------------------------------------------
// Quay geometry fitted from the surveyed CRANE line.
//
// The STS cranes (`crane:<T>:<i>` in positions.json) stand on the real quay
// waterline, so they are the ground truth for where each terminal's wharf is and
// which way it runs. We fit a line through a terminal's cranes to get the quay's
// midpoint, along-quay direction, length and a landward normal — then derive the
// extruded deck, the berth boxes and the berthed-vessel spots FROM that line, so
// every quay asset sits on the crane line instead of on an axis-aligned box at
// the terminal centroid (which floated off the wharf). Pure/deterministic.
// ---------------------------------------------------------------------------

/** ~metres per degree at JNPA's latitude (≈18.94°N). */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((18.94 * Math.PI) / 180);

export interface TerminalQuay {
  id: string;
  /** Quay midpoint (on the crane line). */
  mid: [number, number];
  /** Unit vector ALONG the quay (lng,lat components, not normalised in metres). */
  along: [number, number];
  /** Unit vector pointing LANDWARD (perpendicular to `along`). */
  landward: [number, number];
  /** Quay length along the crane line, metres. */
  lengthM: number;
  /** Bearing of the quay line, deg true. */
  bearingDeg: number;
}

/** All crane [lng,lat] for a terminal, in placement order. */
function cranesOf(terminalId: string): [number, number][] {
  return placementStore
    .keysOfKind('crane')
    .filter((k) => k.split(':')[1] === terminalId)
    .map((k) => {
      const p = placementStore.get(k);
      return p ? ([p.lng, p.lat] as [number, number]) : null;
    })
    .filter((p): p is [number, number] => p != null);
}

/** Convert a lng/lat delta to metres (local flat approximation). */
function toMeters(dLng: number, dLat: number): [number, number] {
  return [dLng * M_PER_DEG_LON, dLat * M_PER_DEG_LAT];
}
/** Convert a metres delta back to lng/lat. */
function toDeg(dxM: number, dyM: number): [number, number] {
  return [dxM / M_PER_DEG_LON, dyM / M_PER_DEG_LAT];
}

/**
 * Fit the quay line for a terminal from its cranes. Uses the two most-separated
 * cranes as the line endpoints (robust to a slightly bent quay) and the port
 * centre to decide which normal points landward. Falls back to the QUAY_BEARING
 * default through the terminal centroid when a terminal has < 2 cranes.
 */
export function terminalQuay(t: TerminalGeo): TerminalQuay {
  const cranes = cranesOf(t.id);

  let mid: [number, number];
  let alongDeg: [number, number]; // along direction in lng/lat
  let lengthM: number;

  if (cranes.length >= 2) {
    // Farthest-apart crane pair = quay endpoints.
    let a = cranes[0];
    let b = cranes[1];
    let best = -1;
    for (let i = 0; i < cranes.length; i++) {
      for (let j = i + 1; j < cranes.length; j++) {
        const [dx, dy] = toMeters(cranes[j][0] - cranes[i][0], cranes[j][1] - cranes[i][1]);
        const d = Math.hypot(dx, dy);
        if (d > best) {
          best = d;
          a = cranes[i];
          b = cranes[j];
        }
      }
    }
    mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const [vx, vy] = toMeters(b[0] - a[0], b[1] - a[1]);
    const len = Math.hypot(vx, vy) || 1;
    lengthM = Math.max(len, 250);
    alongDeg = toDeg(vx / len, vy / len); // 1 m along, in degrees
  } else {
    // Fallback: quay through the terminal centroid at the default bearing.
    mid = [t.lng, t.lat];
    const rad = (QUAY_BEARING * Math.PI) / 180;
    alongDeg = toDeg(Math.sin(rad), Math.cos(rad));
    lengthM = 300;
  }

  // Work the direction/normal in METRIC space (so longitude compression doesn't
  // skew the right angle), then convert back to a "1 m in degrees" unit vector.
  const [amx, amy] = toMeters(alongDeg[0], alongDeg[1]);
  const amMag = Math.hypot(amx, amy) || 1;
  const alongUnitM: [number, number] = [amx / amMag, amy / amMag]; // 1 m along, metric
  const along: [number, number] = toDeg(alongUnitM[0], alongUnitM[1]); // 1 m along, degrees

  // Two metric normals; landward = the one pointing toward the terminal centroid.
  const nA: [number, number] = [-alongUnitM[1], alongUnitM[0]];
  const nB: [number, number] = [alongUnitM[1], -alongUnitM[0]];
  const toCentroidM = toMeters(t.lng - mid[0], t.lat - mid[1]);
  const dotA = nA[0] * toCentroidM[0] + nA[1] * toCentroidM[1];
  const dotB = nB[0] * toCentroidM[0] + nB[1] * toCentroidM[1];
  const landwardM = dotA >= dotB ? nA : nB;
  const landward: [number, number] = toDeg(landwardM[0], landwardM[1]); // 1 m landward, degrees

  const bearingDeg =
    (((Math.atan2(alongUnitM[0], alongUnitM[1]) * 180) / Math.PI) % 360 + 360) % 360;

  return { id: t.id, mid, along, landward, lengthM, bearingDeg };
}

/** Quay geometry for every terminal, keyed by id. */
export const TERMINAL_QUAYS: Record<string, TerminalQuay> = Object.fromEntries(
  TERMINALS.map((t) => [t.id, terminalQuay(t)]),
);

/** Metres → lng/lat offset from a point along an (already unit-ish) direction. */
export function offsetMeters(
  origin: [number, number],
  dir: [number, number],
  meters: number,
): [number, number] {
  return [origin[0] + dir[0] * meters, origin[1] + dir[1] * meters];
}

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
 *
 * The inner/turn/quay reaches must stay IN THE WATER in front of the quays — so
 * they are routed through waypoints offset SEAWARD of each terminal's quay line
 * (fitted from the cranes), not to the terminal centroids (which sit ~400 m
 * inland and dragged the channel onto the container yards).
 */

/** A waypoint `metres` seaward of terminal `id`'s quay midpoint (in the water). */
function seawardOfQuay(id: string, metres: number): [number, number] {
  const q = TERMINAL_QUAYS[id];
  const seaward: [number, number] = [-q.landward[0], -q.landward[1]];
  return offsetMeters(q.mid, seaward, metres);
}

/** Channel runs ~260 m off the quay face — clear water, not on the wharf. */
const CH_SETBACK_M = 260;
const bmctApp = seawardOfQuay('BMCT', CH_SETBACK_M);
const gtiApp = seawardOfQuay('GTI', CH_SETBACK_M);
const nsigtApp = seawardOfQuay('NSIGT', CH_SETBACK_M);
const nsictApp = seawardOfQuay('NSICT', CH_SETBACK_M);

export const CHANNEL: ChannelSegment[] = [
  { id: 'CH-OUTER', name: 'Outer approach', chartedDepthM: 17.5, path: [[outerC[0] - 0.01, outerC[1] - 0.008], outerC] },
  { id: 'CH-MID', name: 'Mid channel', chartedDepthM: 16.2, path: [outerC, waitC] },
  { id: 'CH-INNER', name: 'Inner channel (maintained)', chartedDepthM: 15.0, path: [waitC, [PILOT_STATION.lng, PILOT_STATION.lat]] },
  // Turn off the pilot ground into the water in front of BMCT (the deepest,
  // seaward-most terminal), then run NW parallel to the quay line past GTI,
  // NSIGT, NSICT — every waypoint seaward of the wharf.
  { id: 'CH-TURN', name: 'Turning basin', chartedDepthM: 15.5, path: [[PILOT_STATION.lng, PILOT_STATION.lat], bmctApp] },
  { id: 'CH-QUAY', name: 'Quay approach', chartedDepthM: 16.5, path: [bmctApp, gtiApp, nsigtApp, nsictApp] },
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
