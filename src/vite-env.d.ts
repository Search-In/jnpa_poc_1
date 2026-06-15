/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_MODE?: 'mock' | 'live';
  readonly VITE_PORTAL_URL?: string;
  readonly VITE_ARCGIS_API_KEY?: string;
  readonly VITE_OAUTH_APPID?: string;
  readonly VITE_WEBMAP_ID?: string;
  readonly VITE_STREAM_LAYER_URL?: string;
  readonly VITE_FS_VESSELS_URL?: string;
  readonly VITE_FS_BERTHS_URL?: string;
  readonly VITE_FS_BERTHING_PLAN_URL?: string;
  readonly VITE_FS_PORT_CRAFT_URL?: string;
  readonly VITE_FS_KPI_SNAPSHOTS_URL?: string;
  readonly VITE_AISSTREAM_TOKEN?: string;
  readonly VITE_WEATHER_FEED_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
