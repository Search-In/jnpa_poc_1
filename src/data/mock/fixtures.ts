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
  Vessel,
  WeatherReading,
} from '@/types/domain';

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

// JNPA terminals → berths. Polygons are small rectangles along the quay line.
export const BERTHS: Berth[] = [
  berth('NSICT-1', 'NSICT Berth 1', 'NSICT', 350, 15, 'occupied', 72.945, 18.952),
  berth('NSICT-2', 'NSICT Berth 2', 'NSICT', 350, 15, 'occupied', 72.946, 18.951),
  berth('NSIGT-1', 'NSIGT Berth 1', 'NSIGT', 330, 14.5, 'available', 72.948, 18.95),
  berth('GTI-1', 'GTI Berth 1', 'GTI', 712, 16.5, 'occupied', 72.95, 18.949),
  berth('BMCT-1', 'BMCT Berth 1', 'BMCT', 1000, 16.5, 'reserved', 72.952, 18.948),
  berth('BMCT-2', 'BMCT Berth 2', 'BMCT', 1000, 16.5, 'maintenance', 72.954, 18.947),
];

function berth(
  id: string,
  name: string,
  terminal: string,
  len: number,
  draft: number,
  status: Berth['STATUS'],
  lon: number,
  lat: number
): Berth {
  const d = 0.0008;
  return {
    BERTH_ID: id,
    BERTH_NAME: name,
    TERMINAL: terminal,
    LENGTH_M: len,
    DRAFT_M: draft,
    STATUS: status,
    GEOM: [
      [lon - d, lat - d / 2],
      [lon + d, lat - d / 2],
      [lon + d, lat + d / 2],
      [lon - d, lat + d / 2],
      [lon - d, lat - d / 2],
    ],
  };
}

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

/** Build the live vessel set as of `now`, jittered by `tick` for motion. */
export function makeVessels(now: number, tick: number): Vessel[] {
  const rnd = seededRandom(1234 + tick);
  return VESSEL_SEED.map((v, i) => {
    const status = NAV_CYCLE[i % NAV_CYCLE.length];
    // Anchorage to the SW of the port; approaches from the W channel.
    const baseLon = status === 'moored' || status === 'berthing' ? 72.949 : 72.9 + rnd() * 0.05;
    const baseLat = status === 'moored' || status === 'berthing' ? 18.95 : 18.9 + rnd() * 0.06;
    const drift = (tick % 60) * 0.0002;
    const sog =
      status === 'moored' ? 0 : status === 'anchored' ? 0.1 : 6 + rnd() * 8;
    const cog = Math.round(rnd() * 360);
    return {
      MMSI: v.mmsi,
      VESSEL_NAME: v.name,
      VESSEL_TYPE: v.type,
      NAV_STATUS: status,
      SOG: Number(sog.toFixed(1)),
      COG: cog,
      HEADING: cog,
      LAT: Number((baseLat + drift).toFixed(5)),
      LON: Number((baseLon + drift).toFixed(5)),
      ETA: status === 'approaching' || status === 'anchored' ? now + (2 + i) * H : null,
      BERTH_ID:
        status === 'moored' || status === 'berthing' ? BERTHS[i % BERTHS.length].BERTH_ID : null,
      TIMESTAMP: now,
    };
  });
}

/** A 24h-window berthing plan: some completed, some active, some scheduled. */
export function makeBerthingPlan(now: number): BerthingPlanEntry[] {
  const start = now - 18 * H;
  return VESSEL_SEED.slice(0, 8).map((v, i) => {
    const plannedStart = start + i * 3 * H;
    const plannedEnd = plannedStart + 8 * H;
    // First five are completed/active with actuals; later ones still scheduled.
    const hasActuals = i < 6;
    const isActive = i >= 4 && i < 6;
    // Inject realistic small delays so KPIs aren't all zero.
    const startDelay = (i % 3) * 0.5 * H + 1.5 * H; // pilotage lead + slip
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
