/**
 * scene3d — the 3D marine sea-port layers (ArcGIS SceneView / WebGL). Marine
 * counterpart to the UC-2 cargo scene: a georeferenced JNPA approach rendered as
 * a depth-graded navigation channel, outer/waiting anchorages, the pilot boarding
 * ground, extruded terminal quay decks, and berthed / moving vessels driven by
 * live (simulated) AIS. Every colour comes from theme tokens (quality-bar rule).
 *
 * Layers are built ONCE and then edited in place via applyGraphics (stableOid) so
 * a sim tick tweens the changed vessels instead of blinking the whole layer.
 */
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import Polygon from '@arcgis/core/geometry/Polygon';
import { stableOid } from './applyGraphics';
import {
  CHANNEL,
  ANCHORAGES,
  PILOT_STATION,
  TERMINALS,
  TERMINAL_BY_ID,
  TERMINAL_QUAYS,
  offsetMeters,
  type ChannelSegment,
  type TerminalQuay,
} from './portGeometry';
import { navStatusColor, tokens, ukcColor } from '../theme/tokens';
import type { SeaChannelFeatureCollection } from '@/data/uc3/seaChannels';
import { istTime } from '../util/format';
import type { Vessel, Berth } from '@/types/domain';

/**
 * Shared action buttons shown inside every asset's native Esri detail popup.
 * `PortScene` handles their `trigger-action` events: focus flies the camera to
 * the asset, clear drops the selection ring + closes the popup.
 */
const POPUP_ACTIONS = [
  { id: 'focus-asset', title: 'Focus camera', icon: 'zoom-to-object', className: 'esri-icon-zoom-in-magnifying-glass' },
  { id: 'clear-selection', title: 'Clear', icon: 'x', className: 'esri-icon-close' },
];

/** A titled popup content row block (definition-list style) for rich detail. */
function popupFields(rows: { fieldName: string; label: string }[]) {
  return [{ type: 'fields', fieldInfos: rows.map((r) => ({ fieldName: r.fieldName, label: r.label })) }];
}

/** Depth → channel segment colour ramp (deep = blue, shallow = amber/red). */
function depthColor(depthM: number): [number, number, number, number] {
  if (depthM >= 16.5) return [26, 115, 194, 0.55]; // deep — brand blue
  if (depthM >= 15.5) return [58, 160, 255, 0.5];
  if (depthM >= 15.0) return [242, 169, 59, 0.55]; // maintained pinch — amber
  return [224, 69, 69, 0.6]; // shoal — red
}

// ---- channel (depth-graded ribbons on the sea floor) ------------------------

function channelGraphics(): Graphic[] {
  return CHANNEL.map((seg: ChannelSegment) => {
    const [r, g, b, a] = depthColor(seg.chartedDepthM);
    return new Graphic({
      geometry: new Polyline({ paths: [seg.path], spatialReference: { wkid: 4326 } }),
      attributes: {
        objectId: stableOid(`ch:${seg.id}`),
        segId: seg.id,
        name: seg.name,
        depth: seg.chartedDepthM,
        _r: r, _g: g, _b: b, _a: a,
      },
    });
  });
}

export function channelLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Approach channel (depth-graded)',
    source: channelGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'segId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'depth', type: 'double' },
      { name: '_r', type: 'integer' }, { name: '_g', type: 'integer' },
      { name: '_b', type: 'integer' }, { name: '_a', type: 'double' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'segId',
      uniqueValueInfos: CHANNEL.map((seg) => {
        const [r, g, b, a] = depthColor(seg.chartedDepthM);
        return {
          value: seg.id,
          symbol: {
            type: 'line-3d',
            symbolLayers: [{ type: 'line', size: 14, material: { color: [r, g, b, a] }, cap: 'round' }],
          },
        };
      }),
    } as never,
    popupTemplate: {
      title: '〰️ {name}',
      content: popupFields([{ fieldName: 'depth', label: 'Charted depth (m, below datum)' }]),
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
  });
}

// ---- anchorages + pilot station --------------------------------------------

function anchorageGraphics(): Graphic[] {
  return ANCHORAGES.map(
    (a) =>
      new Graphic({
        geometry: new Polygon({ rings: [a.ring], spatialReference: { wkid: 4326 } }),
        attributes: { objectId: stableOid(`anch:${a.id}`), anchId: a.id, name: a.name },
      }),
  );
}

export function anchorageLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Anchorages',
    source: anchorageGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'anchId', type: 'string' },
      { name: 'name', type: 'string' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [
          { type: 'fill', material: { color: [124, 138, 255, 0.12] }, outline: { color: [124, 138, 255, 0.7], size: 1.5 } },
        ],
      },
    } as never,
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.name' },
        symbol: { type: 'label-3d', symbolLayers: [{ type: 'text', material: { color: tokens.textMuted }, halo: { color: [255, 255, 255, 1], size: 1 }, size: 10 }] },
      },
    ] as never,
    popupTemplate: {
      title: '🛟 {name}',
      content: 'Designated anchorage area — vessels hold here awaiting a pilot / berth window.',
      actions: POPUP_ACTIONS,
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
  });
}

// ---- UC-3 sea channels (uploaded shapefile geometry) -----------------------
// A SEPARATE overlay for the real JNPA_Sea_Channels polygons (core.sea_channel),
// fetched from /api/marine/sea-channels/geojson. It is ADDITIVE: the synthetic
// depth-graded CHANNEL polyline (channelLayer, above) and the DUKC calc are
// untouched — this semi-transparent fill sits above the synthetic ribbon so the
// DUKC channel stays visible underneath. Seeded empty; populated by a PortScene
// data effect (empty FeatureCollection → nothing rendered).
export function seaChannelLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Sea channels (uploaded)',
    source: [] as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'chanId', type: 'integer' },
      { name: 'name', type: 'string' },
      { name: 'section', type: 'string' },
      { name: 'area', type: 'double' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [
          { type: 'fill', material: { color: [34, 197, 194, 0.18] }, outline: { color: [13, 148, 136, 0.85], size: 1.5 } },
        ],
      },
    } as never,
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.name' },
        symbol: { type: 'label-3d', symbolLayers: [{ type: 'text', material: { color: tokens.textMuted }, halo: { color: [255, 255, 255, 1], size: 1 }, size: 9 }] },
      },
    ] as never,
    popupTemplate: {
      title: '🌊 {name}',
      content: popupFields([
        { fieldName: 'section', label: 'Section' },
        { fieldName: 'area', label: 'Area (ha)' },
      ]),
      actions: POPUP_ACTIONS,
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
  });
}

/** Build ArcGIS polygon graphics from the /sea-channels/geojson FeatureCollection.
 *  Pure: coordinates are already [lon,lat] WGS84 (reprojected server-side), so the
 *  GeoJSON rings map directly onto ArcGIS Polygon rings (wkid 4326). */
export function seaChannelGraphics(features: SeaChannelFeatureCollection['features']): Graphic[] {
  const out: Graphic[] = [];
  features.forEach((f, i) => {
    const g = f.geometry;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) return;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const chanId = Number(props.channel_id ?? i);
    out.push(
      new Graphic({
        geometry: new Polygon({ rings: g.coordinates as number[][][], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`seachan:${chanId}`),
          chanId: Number.isFinite(chanId) ? chanId : i,
          name: String(props.name ?? 'Channel'),
          section: String(props.section_label ?? ''),
          area: Number(props.area_ha ?? 0),
        },
      }),
    );
  });
  return out;
}

export function pilotStationLayer(): GraphicsLayer {
  const layer = new GraphicsLayer({ title: 'Pilot boarding ground' });
  layer.add(
    new Graphic({
      geometry: new Point({ longitude: PILOT_STATION.lng, latitude: PILOT_STATION.lat }),
      attributes: { assetId: PILOT_STATION.id, name: PILOT_STATION.name },
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          { type: 'icon', resource: { primitive: 'circle' }, material: { color: tokens.accent }, size: 12, outline: { color: [255, 255, 255, 0.9], size: 1.5 } },
        ],
        verticalOffset: { screenLength: 18 },
        callout: { type: 'line', size: 1.2, color: tokens.accent },
      } as never,
    }),
  );
  return layer;
}

// ---- terminal quay decks (extruded) ----------------------------------------

/** Landward depth of a terminal's quay apron, metres. */
const QUAY_DEPTH_M = 130;
/** How far past the outermost cranes the deck runs at each end, metres. */
const QUAY_END_PAD_M = 40;

/**
 * An ORIENTED quay-deck rectangle fitted to the terminal's crane line: it runs
 * along the quay for its full length (+ a small end pad) and extends landward by
 * QUAY_DEPTH_M, so the deck sits under the cranes on the real wharf instead of
 * as an axis-aligned box at the terminal centroid.
 */
function deckRing(q: TerminalQuay): [number, number][] {
  const half = q.lengthM / 2 + QUAY_END_PAD_M;
  // Waterline edge endpoints (along the crane line, through the mid).
  const wA = offsetMeters(q.mid, q.along, -half);
  const wB = offsetMeters(q.mid, q.along, +half);
  // Landward edge endpoints (pushed inland by the apron depth).
  const lB = offsetMeters(wB, q.landward, QUAY_DEPTH_M);
  const lA = offsetMeters(wA, q.landward, QUAY_DEPTH_M);
  return [wA, wB, lB, lA, wA];
}

function deckGraphics(): Graphic[] {
  return TERMINALS.map((t) => {
    const q = TERMINAL_QUAYS[t.id];
    return new Graphic({
      geometry: new Polygon({ rings: [deckRing(q)], spatialReference: { wkid: 4326 } }),
      attributes: { objectId: stableOid(`deck:${t.id}`), terminalId: t.id, name: t.name, berths: t.berths, maxDraft: t.maxDraftM },
    });
  });
}

export function terminalDeckLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Terminal quays',
    source: deckGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'terminalId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'berths', type: 'integer' },
      { name: 'maxDraft', type: 'double' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [
          { type: 'extrude', size: 6, material: { color: [120, 132, 148, 0.9] }, edges: { type: 'solid', color: [80, 92, 108, 0.9], size: 0.5 } },
        ],
      },
    } as never,
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.name' },
        symbol: { type: 'label-3d', symbolLayers: [{ type: 'text', material: { color: tokens.text }, halo: { color: [255, 255, 255, 1], size: 1.2 }, size: 12 }] },
      },
    ] as never,
    popupTemplate: {
      title: '🏗️ {name}',
      content: popupFields([
        { fieldName: 'terminalId', label: 'Terminal id' },
        { fieldName: 'berths', label: 'Berths' },
        { fieldName: 'maxDraft', label: 'Max design draft (m)' },
      ]),
      actions: POPUP_ACTIONS,
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
  });
}

// ---- berths (quay-line boxes coloured by status) ---------------------------

const berthStatusColor: Record<string, [number, number, number, number]> = {
  available: [45, 187, 106, 0.85],
  occupied: [58, 160, 255, 0.85],
  reserved: [242, 169, 59, 0.85],
  maintenance: [224, 69, 69, 0.85],
};

export function berthGraphics(berths: Berth[]): Graphic[] {
  return berths.map((b) => {
    const c = berthStatusColor[b.STATUS] ?? [139, 151, 166, 0.8];
    return new Graphic({
      geometry: new Polygon({ rings: [b.GEOM as [number, number][]], spatialReference: { wkid: 4326 } }),
      attributes: {
        objectId: stableOid(`berth:${b.BERTH_ID}`),
        berthId: b.BERTH_ID,
        name: b.BERTH_NAME,
        terminal: b.TERMINAL,
        status: b.STATUS,
        draft: b.DRAFT_M,
        _r: c[0], _g: c[1], _b: c[2],
      },
    });
  });
}

export function berthLayer(berths: Berth[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Berths',
    source: berthGraphics(berths) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'berthId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'terminal', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'draft', type: 'double' },
      { name: '_r', type: 'integer' }, { name: '_g', type: 'integer' }, { name: '_b', type: 'integer' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'status',
      uniqueValueInfos: Object.entries(berthStatusColor).map(([status, c]) => ({
        value: status,
        symbol: { type: 'polygon-3d', symbolLayers: [{ type: 'extrude', size: 3, material: { color: c } }] },
      })),
    } as never,
    popupTemplate: {
      title: '⚓ {name} · {terminal}',
      content: popupFields([
        { fieldName: 'berthId', label: 'Berth id' },
        { fieldName: 'terminal', label: 'Terminal' },
        { fieldName: 'status', label: 'Status' },
        { fieldName: 'draft', label: 'Design draft (m)' },
      ]),
      actions: POPUP_ACTIONS,
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
  });
}

// ---- vessels (real ship models, heading-rotated along the channel) ----------

/** Rough vessel length (m) → 3D object size by type, for silhouette variety. */
function vesselSize(type: string): number {
  if (/bulk/i.test(type)) return 240;
  if (/tanker/i.test(type)) return 200;
  return 300; // container
}

/**
 * Real ship GLB per vessel type, giving the live fleet distinct hull
 * silhouettes. Bundled models live in /public/models (shared with the static
 * berthed hero ships). The height (m) roughly tracks vesselSize so a bulk
 * carrier reads shorter than a full container ship.
 */
const VESSEL_MODELS = ['ship-cargo-a', 'ship-cargo-b', 'container-ship'] as const;
type VesselModel = (typeof VESSEL_MODELS)[number];

function vesselModel(type: string): VesselModel {
  if (/bulk/i.test(type)) return 'ship-cargo-a';
  if (/tanker/i.test(type)) return 'ship-cargo-b';
  return 'container-ship'; // container / default
}

/** Nav-status draw order for the status-disc renderer. */
const STATUS_ORDER = ['underway', 'approaching', 'anchored', 'berthing', 'moored'] as const;

export function vesselGraphics(vessels: Vessel[]): Graphic[] {
  return vessels.map((v) => {
    const size = vesselSize(v.VESSEL_TYPE);
    return new Graphic({
      geometry: new Point({ longitude: v.LON, latitude: v.LAT }),
      attributes: {
        objectId: stableOid(`ves:${v.MMSI}`),
        vesselId: v.MMSI,
        name: v.VESSEL_NAME,
        type: v.VESSEL_TYPE,
        status: v.NAV_STATUS,
        // Renderer key = GLB model only (NOT status). Keeping this stable when a
        // vessel's nav-status changes means the mesh is never swapped/reloaded
        // mid-run, so ships don't pop in/out — status is shown by the coloured
        // marker layer above the hull instead.
        model: vesselModel(v.VESSEL_TYPE),
        sog: v.SOG,
        cog: v.COG,
        heading: v.HEADING,
        berth: v.BERTH_ID ?? '—',
        eta: v.ETA ? istTime(v.ETA) : '—',
        size,
      },
    });
  });
}

export function vesselLayer(vessels: Vessel[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Vessels (live AIS · simulated)',
    source: vesselGraphics(vessels) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'vesselId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'sog', type: 'double' },
      { name: 'cog', type: 'double' },
      { name: 'heading', type: 'double' },
      { name: 'berth', type: 'string' },
      { name: 'eta', type: 'string' },
      { name: 'size', type: 'double' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'model',
      // One glTF symbol per hull model — rendered with the model's OWN textures
      // (no flat colour multiply), so each ship looks realistic and varied. A
      // small status-coloured disc floats above the hull for nav-status at a
      // glance. Driving the renderer by model-only keeps the mesh stable across
      // status changes (no reload/flicker).
      uniqueValueInfos: VESSEL_MODELS.map((model) => ({
        value: model,
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              // Rendered with the model's OWN textures — no colour tint — so each
              // ship stays realistic. Nav-status is shown by a separate coloured
              // disc layer (vesselStatusLayer) floating above the hull.
              type: 'object',
              resource: { href: `/models/${model}.glb` },
              height: /^container/.test(model) ? 55 : 42,
              anchor: 'bottom',
            },
          ],
        },
      })),
      // Rotate each ship to its AIS heading (degrees true).
      visualVariables: [{ type: 'rotation', field: 'heading', axis: 'heading' }],
    } as never,
    popupTemplate: {
      title: '🚢 {name}',
      content: popupFields([
        { fieldName: 'vesselId', label: 'MMSI' },
        { fieldName: 'type', label: 'Type' },
        { fieldName: 'status', label: 'Nav status' },
        { fieldName: 'sog', label: 'Speed (kn)' },
        { fieldName: 'cog', label: 'Course (°T)' },
        { fieldName: 'heading', label: 'Heading (°T)' },
        { fieldName: 'berth', label: 'Assigned berth' },
        { fieldName: 'eta', label: 'ETA (IST)' },
      ]),
      actions: POPUP_ACTIONS,
    } as never,
    elevationInfo: { mode: 'relative-to-ground', offset: 0 } as never,
  });
}

// ---- vessel status discs (nav-status marker floating above each hull) -------
// A separate layer of small coloured discs sitting ~90 m above each vessel, so
// nav-status stays readable at a glance while the ship models keep their own
// textures (a colour tint on the glTF would flatten them). Shares the vessel
// objectId scheme so it tweens in lockstep on every sim tick.

export function vesselStatusGraphics(vessels: Vessel[]): Graphic[] {
  return vessels.map(
    (v) =>
      new Graphic({
        geometry: new Point({ longitude: v.LON, latitude: v.LAT }),
        attributes: {
          objectId: stableOid(`vesstat:${v.MMSI}`),
          status: v.NAV_STATUS,
        },
      }),
  );
}

export function vesselStatusLayer(vessels: Vessel[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Vessel status',
    source: vesselStatusGraphics(vessels) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'status', type: 'string' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'status',
      uniqueValueInfos: STATUS_ORDER.map((status) => ({
        value: status,
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'icon',
              resource: { primitive: 'circle' },
              size: 9,
              material: { color: navStatusColor[status] },
              outline: { color: [255, 255, 255, 0.9], size: 1 },
            },
          ],
          // Lift the disc above the hull with a thin callout line down to it.
          verticalOffset: { screenLength: 0, minWorldLength: 95 },
          callout: { type: 'line', size: 0.6, color: [255, 255, 255, 0.4] },
        },
      })),
    } as never,
    elevationInfo: { mode: 'relative-to-ground', offset: 0 } as never,
  });
}

/** Rebuild bundle — the parent PortScene edits these in place each tick. */
export const graphicsFor3d = {
  channel: channelGraphics,
  anchorages: anchorageGraphics,
  decks: deckGraphics,
  berths: berthGraphics,
  vessels: vesselGraphics,
  vesselStatus: vesselStatusGraphics,
};

/**
 * Resolve an asset id → [lng,lat] for camera focus / highlight ringing.
 * Covers terminals, anchorages, the pilot boarding ground AND the channel
 * segments (CH-OUTER…CH-QUAY) — the latter so DUKC/what-if beats that spotlight
 * a stretch of channel (e.g. M2's CH-INNER) actually ring + fly on the map
 * instead of silently no-op-ing.
 */
export function asset3dPosition(): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const t of TERMINALS) m.set(t.id, [t.lng, t.lat]);
  for (const a of ANCHORAGES) {
    // centroid of the ring
    const xs = a.ring.map((p) => p[0]);
    const ys = a.ring.map((p) => p[1]);
    m.set(a.id, [xs.reduce((s, x) => s + x, 0) / xs.length, ys.reduce((s, y) => s + y, 0) / ys.length]);
  }
  for (const seg of CHANNEL) {
    // midpoint of the segment path
    const xs = seg.path.map((p) => p[0]);
    const ys = seg.path.map((p) => p[1]);
    m.set(seg.id, [xs.reduce((s, x) => s + x, 0) / xs.length, ys.reduce((s, y) => s + y, 0) / ys.length]);
  }
  m.set(PILOT_STATION.id, [PILOT_STATION.lng, PILOT_STATION.lat]);
  return m;
}

export { TERMINAL_BY_ID };

/** Amber selection ring dropped when an asset is focused. */
export function selectionRing(lng: number, lat: number): Graphic {
  return new Graphic({
    geometry: new Point({ longitude: lng, latitude: lat }),
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        { type: 'icon', resource: { primitive: 'circle' }, material: { color: [0, 0, 0, 0] }, outline: { color: ukcColor.marginal, size: 3 }, size: 40 },
      ],
    } as never,
  });
}

export function selectionLayer(): GraphicsLayer {
  return new GraphicsLayer({ title: '_selection' });
}
