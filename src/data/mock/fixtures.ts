/**
 * Deterministic JNPA scenario fixtures for the MockAdapter.
 *
 * Geography is centred on Nhava Sheva / Jawaharlal Nehru Port (~18.95°N,
 * 72.95°E). All times are derived from a `now` passed in by the adapter so the
 * scenario stays internally consistent and tests can pin the clock. A small
 * seeded PRNG keeps positions stable across reloads within a session.
 */

import type {
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
  TideStation,
  TideStationsReading,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import { TIDE_STATIONS } from '../tide';
import {
  TERMINALS,
  channelCentreline,
  TERMINAL_QUAYS,
  offsetMeters,
} from '@/map/portGeometry';

const H = 3_600_000;

/** Mulberry32 — tiny deterministic PRNG so the demo is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * JNPA terminals → berths. Berth positions are anchored to the SHARED surveyed
 * geography embedded from PoC_2 (`data/positions.json` → `terminal:<ID>`), so the
 * berths sit on the same quay line UC-2 renders. Small along-quay offsets spread
 * multiple berths at one terminal. Terminal naming follows the shared convention
 * (NSICT/NSIGT/GTI/BMCT/JNPCT).
 */
/** Berth apron depth from the waterline, metres (how far inland the box runs). */
const BERTH_DEPTH_M = 60;
/** Per-terminal count of berth slots we tile along the quay (for even spacing). */
const BERTH_SLOTS: Record<string, number> = { NSICT: 2, NSIGT: 1, GTI: 1, BMCT: 2, JNPCT: 1 };

/**
 * A berth box sitting ON the terminal's quay line (fitted from the cranes), tiled
 * to the `i`-th slot along that line. This replaces the old axis-aligned box at
 * the terminal centroid, so berths align with the real wharf, cranes and vessels.
 */
function termBerth(
  id: string,
  name: string,
  terminal: string,
  len: number,
  draft: number,
  status: Berth['STATUS'],
  i: number,
): Berth {
  const q = TERMINAL_QUAYS[terminal];
  const slots = BERTH_SLOTS[terminal] ?? 1;
  // Centre of slot i within the quay length: divide the line into `slots` cells.
  const cellLen = q.lengthM / slots;
  const centreAlong = -q.lengthM / 2 + cellLen * (i + 0.5);
  const boxLen = Math.min(len, cellLen * 0.92); // fit within its cell
  const midW = offsetMeters(q.mid, q.along, centreAlong); // slot centre on waterline
  // Four corners: two on the waterline, two pushed landward.
  const wA = offsetMeters(midW, q.along, -boxLen / 2);
  const wB = offsetMeters(midW, q.along, +boxLen / 2);
  const lB = offsetMeters(wB, q.landward, BERTH_DEPTH_M);
  const lA = offsetMeters(wA, q.landward, BERTH_DEPTH_M);
  return {
    BERTH_ID: id,
    BERTH_NAME: name,
    TERMINAL: terminal,
    LENGTH_M: len,
    DRAFT_M: draft,
    STATUS: status,
    GEOM: [wA, wB, lB, lA, wA],
  };
}

export const BERTHS: Berth[] = [
  termBerth('NSICT-1', 'NSICT Berth 1', 'NSICT', 350, 15, 'occupied', 0),
  termBerth('NSICT-2', 'NSICT Berth 2', 'NSICT', 350, 15, 'occupied', 1),
  termBerth('NSIGT-1', 'NSIGT Berth 1', 'NSIGT', 330, 14.5, 'available', 0),
  termBerth('GTI-1', 'GTI Berth 1', 'GTI', 712, 16.5, 'occupied', 0),
  termBerth('BMCT-1', 'BMCT Berth 1', 'BMCT', 1000, 16.5, 'reserved', 0),
  termBerth('BMCT-2', 'BMCT Berth 2', 'BMCT', 1000, 16.5, 'maintenance', 1),
  termBerth('JNPCT-1', 'JNPCT Berth 1', 'JNPCT', 300, 13.5, 'available', 0),
];

const VESSEL_SEED = [
  { mmsi: '419000123', name: 'MV BHARAT EXPRESS', type: 'Container Ship' },
  { mmsi: '419000456', name: 'APL CHENNAI', type: 'Container Ship' },
  { mmsi: '563112000', name: 'MAERSK KAVERI', type: 'Container Ship' },
  { mmsi: '477998000', name: 'OOCL NHAVA SHEVA', type: 'Container Ship' },
  { mmsi: '636019000', name: 'MSC ARUNACHAL', type: 'Container Ship' },
  { mmsi: '538090000', name: 'JAG AANCHAL', type: 'Bulk Carrier' },
  { mmsi: '419998001', name: 'SCI MUMBAI', type: 'Tanker' },
  { mmsi: '419998002', name: 'GREAT EASTERN', type: 'Tanker' },
  { mmsi: '419998003', name: 'COSCO KONKAN', type: 'Container Ship' },
  { mmsi: '419998004', name: 'HMM RAIGAD', type: 'Container Ship' },
];

const NAV_CYCLE: Vessel['NAV_STATUS'][] = [
  'approaching',
  'approaching',
  'anchored',
  'anchored',
  'berthing',
  'moored',
  'moored',
  'underway',
  'underway',
  'approaching',
];

/** Terminal ids in shared order, for berthing moored vessels onto real quays. */
const TERMINAL_IDS = TERMINALS.map((t) => t.id);

// --- channel motion: move underway/approaching vessels smoothly seaward→quay --
// The joined channel centreline (outer approach → quay) is the flight path. A
// vessel's progress advances continuously with `tick`, so its position glides
// forward instead of teleporting to a fresh random point each stream update.
const CENTRELINE = channelCentreline();

/** Cumulative arc-length parameterisation of the centreline (in lng/lat units). */
const CENTRELINE_SEGS = (() => {
  const segs: { a: [number, number]; b: [number, number]; len: number; acc: number }[] = [];
  let acc = 0;
  for (let i = 0; i < CENTRELINE.length - 1; i++) {
    const a = CENTRELINE[i];
    const b = CENTRELINE[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, acc });
    acc += len;
  }
  return { segs, total: acc };
})();

/** Bearing (deg true) from point a → b. */
function bearingDeg(a: [number, number], b: [number, number]): number {
  const dLon = b[0] - a[0];
  const dLat = b[1] - a[1];
  const deg = (Math.atan2(dLon, dLat) * 180) / Math.PI; // 0 = north, 90 = east
  return (deg + 360) % 360;
}

/** Point + heading at fractional progress u∈[0,1] along the centreline. */
function alongChannel(u: number): { lng: number; lat: number; heading: number } {
  const { segs, total } = CENTRELINE_SEGS;
  const target = ((u % 1) + 1) % 1 * total; // wrap so vessels loop the run
  for (const s of segs) {
    if (target <= s.acc + s.len || s === segs[segs.length - 1]) {
      const t = s.len > 0 ? (target - s.acc) / s.len : 0;
      return {
        lng: s.a[0] + (s.b[0] - s.a[0]) * t,
        lat: s.a[1] + (s.b[1] - s.a[1]) * t,
        heading: bearingDeg(s.a, s.b),
      };
    }
  }
  const last = segs[segs.length - 1];
  return { lng: last.b[0], lat: last.b[1], heading: bearingDeg(last.a, last.b) };
}

/** Build the live vessel set as of `now`. Underway/approaching vessels advance
 *  along the channel path; berthed/anchored ones hold their station. Identity
 *  (position seed) is per-vessel, NOT per-tick, so the fleet moves smoothly
 *  rather than teleporting each stream update. */
export function makeVessels(now: number, tick: number): Vessel[] {
  return VESSEL_SEED.map((v, i) => {
    const status = NAV_CYCLE[i % NAV_CYCLE.length];
    // Stable per-vessel randomness (seeded by index, not tick) for jitter/speed.
    const idRnd = seededRandom(1234 + i * 97);
    const berthedTerminal = TERMINAL_IDS[i % TERMINAL_IDS.length];
    const atBerth = status === 'moored' || status === 'berthing';
    const anchored = status === 'anchored';

    let lon: number;
    let lat: number;
    let heading: number;
    let sog: number;

    if (atBerth) {
      // Berth the vessel ON its terminal's quay line (fitted from the cranes),
      // floating just SEAWARD of the waterline so the hull lies alongside the
      // wharf — not on the deck and not on top of the static hero ship. Each
      // berthed vessel takes a distinct slot along the quay. Deterministic.
      const q = TERMINAL_QUAYS[berthedTerminal];
      const slot = (i % 3) - 1; // -1, 0, +1 → spread along the quay
      // MSC ARUNACHAL (i=4) berths at JNPCT on slot 0 — the same quay centre the
      // static hero vessel:JNPCT occupies — so nudge it one hull along the quay
      // to clear the overlap. Others keep their tiled slot.
      const alongSlot = i === 4 ? slot + 1 : slot;
      const alongCentre = alongSlot * 250; // ~180 m between berthed hulls
      const centre = offsetMeters(q.mid, q.along, alongCentre);
      // Seaward = opposite of landward; sit ~35 m off the quay edge.
      const seaward: [number, number] = [-q.landward[0], -q.landward[1]];
      const spot = offsetMeters(centre, seaward, 35);
      lon = spot[0];
      lat = spot[1];
      heading = q.bearingDeg; // hull lies along the quay
      sog = 0;
    } else if (anchored) {
      // Holding in the waiting anchorage: a small, STABLE offset (not tick-based)
      // so anchored ships sit still with a gentle swing, not a random jump.
      const swing = Math.sin((tick / 40 + i) % (Math.PI * 2)) * 0.0004;
      lon = 72.885 + idRnd() * 0.02 + swing;
      lat = 18.905 + idRnd() * 0.018 + swing;
      heading = Math.round(idRnd() * 360);
      sog = 0.1;
    } else {
      // Underway / approaching: glide forward along the channel centreline.
      // Each vessel starts at a staggered offset and advances with tick so the
      // fleet threads the channel like real traffic. speed sets progress rate.
      const speedKn = 6 + idRnd() * 8;
      const start = idRnd(); // staggered entry point along the run
      const progress = start + (tick * speedKn) / 9000; // slow, smooth advance
      const p = alongChannel(progress);
      lon = p.lng;
      lat = p.lat;
      heading = Math.round(p.heading);
      sog = Number(speedKn.toFixed(1));
    }

    return {
      MMSI: v.mmsi,
      VESSEL_NAME: v.name,
      VESSEL_TYPE: v.type,
      NAV_STATUS: status,
      SOG: Number(sog.toFixed(1)),
      COG: heading,
      HEADING: heading,
      LAT: Number(lat.toFixed(5)),
      LON: Number(lon.toFixed(5)),
      ETA: status === 'approaching' || status === 'anchored' ? now + (2 + i) * H : null,
      BERTH_ID:
        status === 'moored' || status === 'berthing' ? BERTHS[i % BERTHS.length].BERTH_ID : null,
      TIMESTAMP: now,
      SOURCE: 'mock' as const,
    };
  });
}

/** A 24h-window berthing plan: some completed, some active, some scheduled. */
/**
 * Deterministic per-call arrival deltas (minutes vs recommended slot) for the
 * completed/active plan entries. A realistic spread: several calls land inside
 * the ±60-min JIT window, several miss it — so Just-In-Time computes to a live
 * ~60-75%, not the flat 0% the old "uniformly 1.5-2.5h late" pattern produced,
 * nor a trivial 100%. Signed so a couple arrive early. Index-keyed → reproducible.
 */
const ARRIVAL_DELTA_MIN = [12, -25, 95, 40, -8, 150];

export function makeBerthingPlan(now: number): BerthingPlanEntry[] {
  const start = now - 18 * H;
  return VESSEL_SEED.slice(0, 8).map((v, i) => {
    const plannedStart = start + i * 3 * H;
    const plannedEnd = plannedStart + 8 * H;
    // First six are completed/active with actuals; later ones still scheduled.
    const hasActuals = i < 6;
    const isActive = i >= 4 && i < 6;
    // Arrival slip vs recommended slot — some within JIT tolerance, some not.
    const startDelay = (ARRIVAL_DELTA_MIN[i] ?? 0) * 60_000;
    const actualStart = hasActuals ? plannedStart + startDelay : null;
    const actualEnd =
      hasActuals && !isActive ? plannedEnd + ((i % 2) * H + 2 * H) : null;
    return {
      PLAN_ID: `PLAN-${1000 + i}`,
      BERTH_ID: BERTHS[i % BERTHS.length].BERTH_ID,
      MMSI: v.mmsi,
      VESSEL_NAME: v.name,
      PLANNED_START: plannedStart,
      PLANNED_END: plannedEnd,
      ACTUAL_START: actualStart,
      ACTUAL_END: actualEnd,
      STATUS: !hasActuals ? 'scheduled' : isActive ? 'active' : 'completed',
    };
  });
}

export function makePortCraft(now: number): PortCraftUnit[] {
  const mk = (
    id: string,
    type: PortCraftUnit['TYPE'],
    status: PortCraftUnit['STATUS'],
    mmsi: string | null,
    respMin: number | null
  ): PortCraftUnit => ({
    CRAFT_ID: id,
    TYPE: type,
    STATUS: status,
    ASSIGNED_MMSI: mmsi,
    DEPLOYED_AT: status === 'deployed' ? now - 0.5 * H : null,
    RESPONSE_MIN: respMin,
  });
  return [
    mk('PILOT-1', 'pilot', 'deployed', '419000123', 18),
    mk('PILOT-2', 'pilot', 'idle', null, 22),
    mk('PILOT-3', 'pilot', 'deployed', '563112000', 31),
    mk('TUG-1', 'tug', 'deployed', '419000123', 12),
    mk('TUG-2', 'tug', 'deployed', '419000123', 14),
    mk('TUG-3', 'tug', 'idle', null, 16),
    mk('TUG-4', 'tug', 'returning', null, 20),
    mk('MOOR-1', 'mooring', 'deployed', '477998000', 9),
    mk('MOOR-2', 'mooring', 'idle', null, 11),
  ];
}

/** 24 hourly KPI snapshots ending at `now`, with mild noise + trend. */
export function makeKpiSnapshots(now: number): KpiSnapshot[] {
  const rnd = seededRandom(99);
  const out: KpiSnapshot[] = [];
  for (let h = 23; h >= 0; h--) {
    const ts = now - h * H;
    const wobble = (base: number, amp: number) => base + (rnd() - 0.5) * amp;
    out.push({
      TS: ts,
      PRE_BERTH_DELAY: Number(wobble(2.4, 1.0).toFixed(2)),
      PRE_SAIL_DELAY: Number(wobble(2.1, 0.8).toFixed(2)),
      AVG_TAT: Number(wobble(26, 4).toFixed(2)),
      JIT_PCT: Number(wobble(74, 12).toFixed(1)),
      FORECAST_ACC: Number(wobble(88, 6).toFixed(1)),
      BERTH_OCC: Number(wobble(72, 10).toFixed(1)),
      ANCHORED: Math.max(0, Math.round(wobble(4, 3))),
      APPROACHING: Math.max(0, Math.round(wobble(7, 4))),
    });
  }
  return out;
}

export function makePredictions(now: number): PredictionPoint[] {
  const rnd = seededRandom(2024);
  return VESSEL_SEED.map((v, i) => {
    const predictedEta = now - (i + 1) * H;
    // Actual differs from predicted by a small error → ~85–92% accuracy.
    const errH = (rnd() - 0.5) * 2;
    const actualAta = i < 7 ? predictedEta + errH * H : null;
    return {
      MMSI: v.mmsi,
      VESSEL_NAME: v.name,
      predictedEta,
      actualAta,
    };
  });
}

export function makeWeather(now: number, tick: number): WeatherReading {
  const rnd = seededRandom(7 + tick);
  return {
    TS: now,
    windKt: Number((10 + rnd() * 8).toFixed(1)),
    windDir: Math.round(220 + rnd() * 40), // SW monsoon-ish
    seaStateM: Number((1.2 + rnd() * 0.8).toFixed(1)),
    visibilityNm: Number((6 + rnd() * 4).toFixed(1)),
    tideM: Number((2.5 + Math.sin(tick / 6) * 1.5).toFixed(2)),
  };
}

/**
 * Simulated tide + sea-state readings for the fixed station roster (offline /
 * mock mode). A shared semidiurnal tide phase drives every station's height (so
 * the whole port rises/falls together, as it physically would), with a small
 * per-station offset; sea state trends up toward the exposed outer stations.
 */
export function makeTideStations(now: number, tick: number): TideStationsReading {
  // Semidiurnal-ish phase: full cycle every ~12 ticks. Height and its slope one
  // step earlier give the rising/falling/slack trend.
  const phase = tick / 6;
  const height = (p: number, offset: number) => 2.5 + Math.sin(p) * 1.5 + offset;
  const stations: TideStation[] = TIDE_STATIONS.map((s, i) => {
    const rnd = seededRandom(41 + i * 13 + tick);
    const offset = (i - 2) * 0.08; // slight spatial gradient across the port
    const hNow = height(phase, offset);
    const hPrev = height(phase - 0.15, offset);
    const dh = hNow - hPrev;
    const trend: TideStation['tideTrend'] = dh > 0.02 ? 'rising' : dh < -0.02 ? 'falling' : 'slack';
    // Outer stations (later in the roster) see rougher water.
    const exposure = 0.6 + i * 0.18;
    return {
      STATION_ID: s.STATION_ID,
      NAME: s.NAME,
      LAT: s.LAT,
      LON: s.LON,
      tideM: Number(hNow.toFixed(2)),
      tideTrend: trend,
      seaStateM: Number((exposure + rnd() * 0.4).toFixed(1)),
      swellM: Number((exposure * 0.6 + rnd() * 0.3).toFixed(1)),
      windKt: Number((10 + rnd() * 8).toFixed(1)),
      windDir: Math.round(220 + rnd() * 40),
      TS: now,
    };
  });
  return { TS: now, stations };
}
