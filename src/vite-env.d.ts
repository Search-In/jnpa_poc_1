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
  readonly VITE_HISTORY_HOURS?: string;
  readonly VITE_AIS_BBOX?: string;
  readonly VITE_MAP_CENTER?: string;
  readonly VITE_MAP_ZOOM?: string;
  readonly VITE_LIVE_REGION_LABEL?: string;
  readonly VITE_LIVE_REGION_IS_TARGET?: string;
  // UC-3 shared backend (see src/data/config.ts → env.uc3).
  readonly VITE_UC3_ENABLED?: string;
  readonly VITE_UC3_API_BASE?: string;
  // Sign-in gate, same variable and semantics as UC-3's console. Unset = no
  // login step (the credential-free mock/demo build). There are deliberately no
  // username/password variables: Vite inlines VITE_* into the shipped bundle.
  readonly VITE_AUTH_ENABLED?: string;
  /** Demo pin ISO (e.g. 2026-06-09T08:30:00+05:30). Authoritative twin clock. */
  readonly VITE_UC3_AS_OF?: string;
  // UC-1 Gen-2 model service (see src/data/config.ts → env.ml). Serves on :8100.
  readonly VITE_ML_ENABLED?: string;
  readonly VITE_ML_API_BASE?: string;
  readonly VITE_ML_API_URL?: string;
  readonly VITE_ML_MAX_FLEET?: string;
  readonly VITE_ML_TIMEOUT_MS?: string;
  // NLDS Logistics Data Bank container track (see src/data/config.ts → env.ldb).
  readonly VITE_LDB_ENABLED?: string;
  readonly VITE_LDB_PROXY_BASE?: string;
  readonly VITE_LDB_ACCESS_TOKEN?: string;
  readonly VITE_LDB_MOBILE_NO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
