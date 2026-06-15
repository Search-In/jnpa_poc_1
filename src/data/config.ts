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
}

function str(v: string | undefined, fallback = ''): string {
  return v ?? fallback;
}

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
};
