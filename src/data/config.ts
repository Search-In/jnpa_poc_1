/** Typed access to the Vite build-time env. Centralised so adapters and the
 * selector read config from one place (and missing-var errors are explicit). */

export interface AppEnv {
  dataMode: 'mock' | 'live';
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
   * Live AIS region. JNPA/Indian waters have no free public AIS coverage, so
   * the demo can re-centre on a region that does (default: Rotterdam) to show
   * genuine real-time vessels. All env-overridable; clear to JNPA geography the
   * moment a covering feed (Velocity/licensed) is configured.
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

// Rotterdam — densest live AISStream coverage as of build time. Override via env.
const ROTTERDAM_BBOX = [
  [51.85, 3.9],
  [52.05, 4.5],
];

export const env: AppEnv = {
  dataMode: (import.meta.env.VITE_DATA_MODE as 'mock' | 'live') ?? 'mock',
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
  weatherFeedUrl: str(import.meta.env.VITE_WEATHER_FEED_URL),
  historyHours: num(import.meta.env.VITE_HISTORY_HOURS, 336),
  liveRegion: {
    bbox: parseBbox(import.meta.env.VITE_AIS_BBOX, ROTTERDAM_BBOX),
    center: str(import.meta.env.VITE_MAP_CENTER, '4.15,51.95'),
    zoom: num(import.meta.env.VITE_MAP_ZOOM, 11),
    label: str(import.meta.env.VITE_LIVE_REGION_LABEL, 'Rotterdam (live AIS coverage demo)'),
    // Stand-in unless the operator explicitly says this region IS the target.
    isStandIn: str(import.meta.env.VITE_LIVE_REGION_IS_TARGET) !== 'true',
  },
};
