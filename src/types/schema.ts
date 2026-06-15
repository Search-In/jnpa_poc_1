/**
 * ArcGIS Feature Service field definitions for each layer.
 *
 * These are the source of truth for (a) publishing Hosted Feature Layers and
 * (b) the seed-CSV column order. They intentionally mirror the domain types in
 * `domain.ts` field-for-field. Geometry is described separately because the FS
 * carries it in `geometry`, not `attributes`.
 *
 * Esri field-type reference: esriFieldTypeOID | esriFieldTypeString |
 * esriFieldTypeDouble | esriFieldTypeInteger | esriFieldTypeDate.
 */

export type EsriFieldType =
  | 'esriFieldTypeOID'
  | 'esriFieldTypeString'
  | 'esriFieldTypeDouble'
  | 'esriFieldTypeInteger'
  | 'esriFieldTypeDate';

export interface EsriFieldDef {
  name: string;
  type: EsriFieldType;
  alias: string;
  length?: number;
  nullable?: boolean;
}

export type EsriGeometryType =
  | 'esriGeometryPoint'
  | 'esriGeometryPolygon'
  | 'none';

export interface LayerSchema {
  /** Logical name used in `.env` URL keys and the publish script. */
  name: string;
  geometryType: EsriGeometryType;
  /** Field used as the track id for the Stream Layer (MMSI), if applicable. */
  trackIdField?: string;
  /** Field used as the time field for spatiotemporal layers. */
  timeField?: string;
  fields: EsriFieldDef[];
}

const OID: EsriFieldDef = {
  name: 'OBJECTID',
  type: 'esriFieldTypeOID',
  alias: 'OBJECTID',
};

export const VESSELS_SCHEMA: LayerSchema = {
  name: 'Vessels',
  geometryType: 'esriGeometryPoint',
  trackIdField: 'MMSI',
  timeField: 'TIMESTAMP',
  fields: [
    OID,
    { name: 'MMSI', type: 'esriFieldTypeString', alias: 'MMSI', length: 16 },
    { name: 'VESSEL_NAME', type: 'esriFieldTypeString', alias: 'Vessel Name', length: 128 },
    { name: 'VESSEL_TYPE', type: 'esriFieldTypeString', alias: 'Vessel Type', length: 64 },
    { name: 'NAV_STATUS', type: 'esriFieldTypeString', alias: 'Nav Status', length: 32 },
    { name: 'SOG', type: 'esriFieldTypeDouble', alias: 'Speed Over Ground (kn)' },
    { name: 'COG', type: 'esriFieldTypeDouble', alias: 'Course Over Ground (deg)' },
    { name: 'HEADING', type: 'esriFieldTypeDouble', alias: 'Heading (deg)' },
    { name: 'LAT', type: 'esriFieldTypeDouble', alias: 'Latitude' },
    { name: 'LON', type: 'esriFieldTypeDouble', alias: 'Longitude' },
    { name: 'ETA', type: 'esriFieldTypeDate', alias: 'ETA', nullable: true },
    { name: 'BERTH_ID', type: 'esriFieldTypeString', alias: 'Berth Id', length: 16, nullable: true },
    { name: 'TIMESTAMP', type: 'esriFieldTypeDate', alias: 'Timestamp' },
  ],
};

export const BERTHS_SCHEMA: LayerSchema = {
  name: 'Berths',
  geometryType: 'esriGeometryPolygon',
  fields: [
    OID,
    { name: 'BERTH_ID', type: 'esriFieldTypeString', alias: 'Berth Id', length: 16 },
    { name: 'BERTH_NAME', type: 'esriFieldTypeString', alias: 'Berth Name', length: 64 },
    { name: 'TERMINAL', type: 'esriFieldTypeString', alias: 'Terminal', length: 64 },
    { name: 'LENGTH_M', type: 'esriFieldTypeDouble', alias: 'Length (m)' },
    { name: 'DRAFT_M', type: 'esriFieldTypeDouble', alias: 'Max Draft (m)' },
    { name: 'STATUS', type: 'esriFieldTypeString', alias: 'Status', length: 32 },
  ],
};

export const BERTHING_PLAN_SCHEMA: LayerSchema = {
  name: 'BerthingPlan',
  geometryType: 'none',
  timeField: 'PLANNED_START',
  fields: [
    OID,
    { name: 'PLAN_ID', type: 'esriFieldTypeString', alias: 'Plan Id', length: 24 },
    { name: 'BERTH_ID', type: 'esriFieldTypeString', alias: 'Berth Id', length: 16 },
    { name: 'MMSI', type: 'esriFieldTypeString', alias: 'MMSI', length: 16 },
    { name: 'VESSEL_NAME', type: 'esriFieldTypeString', alias: 'Vessel Name', length: 128 },
    { name: 'PLANNED_START', type: 'esriFieldTypeDate', alias: 'Planned Start' },
    { name: 'PLANNED_END', type: 'esriFieldTypeDate', alias: 'Planned End' },
    { name: 'ACTUAL_START', type: 'esriFieldTypeDate', alias: 'Actual Start (ATB)', nullable: true },
    { name: 'ACTUAL_END', type: 'esriFieldTypeDate', alias: 'Actual End (ATD)', nullable: true },
    { name: 'STATUS', type: 'esriFieldTypeString', alias: 'Status', length: 32 },
  ],
};

export const PORT_CRAFT_SCHEMA: LayerSchema = {
  name: 'PortCraft',
  geometryType: 'esriGeometryPoint',
  fields: [
    OID,
    { name: 'CRAFT_ID', type: 'esriFieldTypeString', alias: 'Craft Id', length: 16 },
    { name: 'TYPE', type: 'esriFieldTypeString', alias: 'Type', length: 16 },
    { name: 'STATUS', type: 'esriFieldTypeString', alias: 'Status', length: 32 },
    { name: 'ASSIGNED_MMSI', type: 'esriFieldTypeString', alias: 'Assigned MMSI', length: 16, nullable: true },
    { name: 'DEPLOYED_AT', type: 'esriFieldTypeDate', alias: 'Deployed At', nullable: true },
    { name: 'RESPONSE_MIN', type: 'esriFieldTypeDouble', alias: 'Response (min)', nullable: true },
  ],
};

export const KPI_SNAPSHOTS_SCHEMA: LayerSchema = {
  name: 'KPISnapshots',
  geometryType: 'none',
  timeField: 'TS',
  fields: [
    OID,
    { name: 'TS', type: 'esriFieldTypeDate', alias: 'Timestamp' },
    { name: 'PRE_BERTH_DELAY', type: 'esriFieldTypeDouble', alias: 'Pre-Berthing Delay (h)' },
    { name: 'PRE_SAIL_DELAY', type: 'esriFieldTypeDouble', alias: 'Pre-Sailing Delay (h)' },
    { name: 'AVG_TAT', type: 'esriFieldTypeDouble', alias: 'Avg Vessel TAT (h)' },
    { name: 'JIT_PCT', type: 'esriFieldTypeDouble', alias: 'Just-In-Time (%)' },
    { name: 'FORECAST_ACC', type: 'esriFieldTypeDouble', alias: 'Forecast Accuracy (%)' },
    { name: 'BERTH_OCC', type: 'esriFieldTypeDouble', alias: 'Berth Occupancy (%)' },
    { name: 'ANCHORED', type: 'esriFieldTypeInteger', alias: 'Anchored Vessels' },
    { name: 'APPROACHING', type: 'esriFieldTypeInteger', alias: 'Approaching Vessels' },
  ],
};

export const ALL_SCHEMAS: LayerSchema[] = [
  VESSELS_SCHEMA,
  BERTHS_SCHEMA,
  BERTHING_PLAN_SCHEMA,
  PORT_CRAFT_SCHEMA,
  KPI_SNAPSHOTS_SCHEMA,
];
