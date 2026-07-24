/** Typed access to the Vite build-time env. Centralised so adapters and the
 * selector read config from one place (and missing-var errors are explicit). */

export interface AppEnv {
  /**
   * mock   — offline simulated fleet, zero credentials (default).
   * live   — real feeds only (Velocity StreamLayer / aisstream), no simulation.
   * hybrid — simulated JNPA fleet WITH real aisstream.io vessels layered on top
   *          (LiveOverlayAdapter). Needs VITE_AISSTREAM_TOKEN for the live layer.
   */
  dataMode: 'mock' | 'live' | 'hybrid';
  portalUrl: string;
  arcgisApiKey: string;
  oauthAppId: string;
  webMapId: string;
  streamLayerUrl: string;
  fs: {
    vessels: string;
    berths: string;
    berthingPlan: string;
    portCraft: string;
    kpiSnapshots: string;
  };
  aisStreamToken: string;
  /**
   * AISHub public station-map live overlay (hybrid mode). Real JNPA/Nhava Sheva
   * vessels scraped from the station's map.json (no API username needed). See
   * src/data/aishub.ts. Disabled when `enabled` is false.
   */
  aisHub: {
    enabled: boolean;
    /** Station id covering the target port (2387 = JNPA/Mumbai). */
    station: string;
    /** Fetch base — dev proxy prefix by default (CORS + origin gating). */
    proxyBase: string;
    /**
     * Serve the bundled JNPA sample when a live fetch is blocked/empty, so the
     * demo shows real hulls rather than blank. Turn off for live-only.
     */
    useSampleFallback: boolean;
    /**
     * AoI box for AISHub DQ validation — the STATION's coverage, wider than the
     * tight AISStream JNPA box (which would drop half the Mumbai-approaches
     * hulls the station legitimately reports). [[swLat,swLon],[neLat,neLon]].
     */
    aoiBbox: number[][];
  };
  weatherFeedUrl: string;
  /**
   * Default lookback (hours) for the historical/report widgets (berthing plan,
   * delay/TAT trends, arrivals, prediction). Seed Feature Layers hold a few
   * days of fixed-date data, so a generous window keeps the widgets populated
   * even when the seed dates don't align with the live clock. Real live history
   * can narrow this via VITE_HISTORY_HOURS.
   */
  historyHours: number;
  /**
   * Live AIS region. The demo runs on JNPA / Nhava Sheva geography by default
   * (simulated feed, honestly labelled). JNPA/Indian waters have no *free* public
   * AIS coverage, so — only when the operator explicitly opts in via env — the
   * live-AIS demo can re-centre on a covered region (e.g. Rotterdam) purely to
   * show genuine real-time vessel motion; that region is always flagged as a
   * coverage stand-in, never presented as JNPA. Clear the override the moment a
   * covering feed (Velocity/licensed) is configured.
   */
  liveRegion: {
    /** [[swLat, swLon], [neLat, neLon]] AIS subscription box. */
    bbox: number[][];
    /** Map center "lon,lat". */
    center: string;
    zoom: number;
    /** Human label shown in the UI when not using JNPA geography. */
    label: string;
    /** True when the region is a coverage stand-in (not JNPA). */
    isStandIn: boolean;
  };
  /**
   * UC-3 shared backend (the common JNPA gateway) — the source of Shipping Line
   * master data (`GET /api/shipping-lines/lines`, RBAC: control room + customs).
   *
   * Deliberately INDEPENDENT of `dataMode`: shipping-line rows are real records
   * from the shared database whether or not the AIS feed is simulated, so mock
   * mode must not silently imply "no UC-3" and live mode must not imply "UC-3".
   * Two orthogonal switches — flip this one with VITE_UC3_ENABLED.
   *
   * SCOPE HONESTY: `username`/`password` are Vite build-time values, so they are
   * INLINED INTO THE BUNDLE and readable by anyone with devtools. That is
   * acceptable only for the PoC demo credential. Production must move the login
   * server-side (a real sign-in, or token injection at the nginx tier) — the
   * same posture note as the client-side role scoping in src/auth/roles.ts.
   */
  uc3: {
    /** Master switch. Off → the app never contacts UC-3 (mock stays offline). */
    enabled: boolean;
    /**
     * Path prefix the app calls, NOT an absolute origin. Left relative ("/api")
     * so the dev proxy (vite.config.ts) and nginx keep the browser same-origin.
     * Endpoint helpers therefore pass the SUFFIX only ("/auth/login"), never the
     * full "/api/auth/login" — that would resolve to "/api/api/…".
     */
    apiBase: string;
    /** PoC login (POST {apiBase}/auth/login). See the scope-honesty note above. */
    username: string;
    password: string;
  };
}

function str(v: string | undefined, fallback = ''): string {
  return v ?? fallback;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
}

/** Parse "swLat,swLon,neLat,neLon" → [[swLat,swLon],[neLat,neLon]]; else fallback. */
function parseBbox(v: string | undefined, fallback: number[][]): number[][] {
  if (!v) return fallback;
  const p = v.split(',').map(Number);
  if (p.length === 4 && p.every((x) => Number.isFinite(x))) {
    return [
      [p[0], p[1]],
      [p[2], p[3]],
    ];
  }
  return fallback;
}

// JNPA / Nhava Sheva approaches — the true target geography (default for the
// simulated feed). [[swLat, swLon], [neLat, neLon]].
const JNPA_BBOX = [
  [18.86, 72.86],
  [19.02, 73.02],
];

// Rotterdam — densest FREE live AISStream coverage as of build time. Used ONLY
// as an opt-in live-AIS coverage stand-in (VITE_AIS_BBOX / VITE_LIVE_REGION_*),
// never as the default framing. Kept here so the stand-in is one env flag away.
const ROTTERDAM_STANDIN_BBOX = [
  [51.85, 3.9],
  [52.05, 4.5],
];
void ROTTERDAM_STANDIN_BBOX;

export const env: AppEnv = {
  dataMode: (import.meta.env.VITE_DATA_MODE as 'mock' | 'live' | 'hybrid') ?? 'mock',
  portalUrl: str(import.meta.env.VITE_PORTAL_URL, 'https://www.arcgis.com'),
  arcgisApiKey: str(import.meta.env.VITE_ARCGIS_API_KEY),
  oauthAppId: str(import.meta.env.VITE_OAUTH_APPID),
  webMapId: str(import.meta.env.VITE_WEBMAP_ID),
  streamLayerUrl: str(import.meta.env.VITE_STREAM_LAYER_URL),
  fs: {
    vessels: str(import.meta.env.VITE_FS_VESSELS_URL),
    berths: str(import.meta.env.VITE_FS_BERTHS_URL),
    berthingPlan: str(import.meta.env.VITE_FS_BERTHING_PLAN_URL),
    portCraft: str(import.meta.env.VITE_FS_PORT_CRAFT_URL),
    kpiSnapshots: str(import.meta.env.VITE_FS_KPI_SNAPSHOTS_URL),
  },
  aisStreamToken: str(import.meta.env.VITE_AISSTREAM_TOKEN),
  aisHub: {
    // On by default in hybrid mode so the JNPA map shows real hulls out of the
    // box (the bundled sample guarantees content even if the live fetch fails).
    enabled: str(import.meta.env.VITE_AISHUB_ENABLED, 'true') !== 'false',
    station: str(import.meta.env.VITE_AISHUB_STATION, '2387'),
    proxyBase: str(import.meta.env.VITE_AISHUB_PROXY_BASE, '/aishub-proxy'),
    useSampleFallback: str(import.meta.env.VITE_AISHUB_SAMPLE_FALLBACK, 'true') !== 'false',
    // Station 2387 coverage (Mumbai/Nhava Sheva approaches), padded slightly.
    // Overridable via VITE_AISHUB_AOI_BBOX="swLat,swLon,neLat,neLon".
    aoiBbox: parseBbox(import.meta.env.VITE_AISHUB_AOI_BBOX, [
      [18.7, 72.45],
      [19.25, 73.0],
    ]),
  },
  weatherFeedUrl: str(import.meta.env.VITE_WEATHER_FEED_URL),
  historyHours: num(import.meta.env.VITE_HISTORY_HOURS, 336),
  liveRegion: {
    bbox: parseBbox(import.meta.env.VITE_AIS_BBOX, JNPA_BBOX),
    center: str(import.meta.env.VITE_MAP_CENTER, '72.95,18.95'),
    zoom: num(import.meta.env.VITE_MAP_ZOOM, 12),
    label: str(import.meta.env.VITE_LIVE_REGION_LABEL, 'JNPA / Nhava Sheva approaches'),
    // A region is only a "stand-in" when the operator points the live AIS box at
    // a non-JNPA area (e.g. Rotterdam) for coverage AND doesn't flag it as target.
    isStandIn:
      str(import.meta.env.VITE_AIS_BBOX) !== '' &&
      str(import.meta.env.VITE_LIVE_REGION_IS_TARGET) !== 'true',
  },
  uc3: {
    // On by default so a configured gateway works out of the box; set
    // VITE_UC3_ENABLED=false to keep the app fully offline (same opt-out idiom
    // as aisHub.enabled above).
    enabled: str(import.meta.env.VITE_UC3_ENABLED, 'true') !== 'false',
    apiBase: str(import.meta.env.VITE_UC3_API_BASE, '/api'),
    username: str(import.meta.env.VITE_UC3_USERNAME),
    password: str(import.meta.env.VITE_UC3_PASSWORD),
  },
};
