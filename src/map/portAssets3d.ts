/**
 * portAssets3d — real glTF port-infrastructure models placed from the surveyed
 * `data/positions.json` (shared UC-1/UC-2 geography), rendered in the ArcGIS
 * SceneView. This is the fleet of CC0/CC-BY meshes ported from UC-2 (PoC_2):
 * STS gantry cranes, yard container stacks, toll-naka gates, gate-queue trucks,
 * a harbour tug and berthed hero vessels — all seated on their exact JNPA
 * coordinates from the placement store.
 *
 * UC-1's live AIS fleet (moving cube-hull ships coloured by NAV_STATUS) stays in
 * scene3d.ts; THIS module adds the static, georeferenced port infrastructure so
 * the 3D scene reads as the real Nhava Sheva terminals, not an empty channel.
 *
 * Every model is placed directly from a placement key in positions.json
 * (`crane:<T>:<i>`, `yard:<T>:<i>`, `gate3d:<GATE>`, `truckroute:<T>`, `tug`,
 * `vessel:<T>`), so a positions.json edit (or an in-scene drag via placementStore)
 * moves the model with pixel-accurate fidelity to the survey. Assets not present
 * in the file are simply skipped — the file is the single source of truth.
 *
 * Models live under /models (public/models, vendored from UC-2; see CREDITS.md).
 */
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import { stableOid } from './applyGraphics';
import { placementStore } from './placementStore';
import { QUAY_BEARING, TERMINALS, TERMINAL_QUAYS, offsetMeters } from './portGeometry';

const MODELS = '/models';

/** Default model heading: the quay bearing turned a quarter-turn so a model's
 *  long axis runs parallel to the wharf (same lever UC-2 uses). */
const QUAY_HEADING = (QUAY_BEARING + 90) % 360;

/** Every yard tier steps up by one ISO-container height (m). */
const CONTAINER_H_M = 5.8;
const YARD_MODELS = ['red', 'green', 'blue'] as const;

/** All placement keys of one kind, e.g. keysOf('crane') → ['crane:NSICT:0', …]. */
function keysOf(kind: string): string[] {
  return placementStore.keysOfKind(kind);
}

/** [lng,lat] for a placement key, or null if it isn't in positions.json. */
function pos(key: string): [number, number] | null {
  const p = placementStore.get(key);
  return p ? [p.lng, p.lat] : null;
}

/** Heading for a key: its own override, else the shared quay heading. */
function heading(key: string, fallback = QUAY_HEADING): number {
  const p = placementStore.get(key);
  return p?.heading != null ? p.heading : fallback;
}

// ---------------------------------------------------------------------------
// STS gantry cranes — real quay-crane GLB on the waterline of each terminal.
// One graphic per `crane:<T>:<i>` key in positions.json.
// ---------------------------------------------------------------------------

function craneGraphics(): Graphic[] {
  return keysOf('crane')
    .map((key) => {
      const p = pos(key);
      if (!p) return null;
      const [, terminalId, idx] = key.split(':');
      return new Graphic({
        geometry: new Point({ longitude: p[0], latitude: p[1], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`crane3d:${key}`),
          pkey: key,
          craneId: `${terminalId}-STS${Number(idx) + 1}`,
          terminalId,
          heading: heading(key),
        },
      });
    })
    .filter((g): g is Graphic => g != null);
}

export function craneLayer(): FeatureLayer {
  return new FeatureLayer({
    title: '3D · STS cranes',
    source: craneGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'craneId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' } as never,
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/sts-crane.glb` }, height: 68, anchor: 'bottom' }],
      },
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Crane {craneId}', content: 'Terminal: {terminalId}' } as never,
  });
}

// ---------------------------------------------------------------------------
// Yard container stacks — a small tiered stack of ISO-container GLBs at each
// `yard:<T>:<i>` block anchor. A deterministic per-block hash sets the tier
// count so blocks read as a real, uneven container yard.
// ---------------------------------------------------------------------------

/** Deterministic 0..1 from a key — no Math.random (stable replays). */
function rand01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function yardGraphics(): Graphic[] {
  const out: Graphic[] = [];
  keysOf('yard').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const [, terminalId, idx] = key.split(':');
    const i = Number(idx) || 0;
    // 2..5 tiers, stable per block.
    const tiers = 2 + Math.round(rand01(key) * 3);
    const hd = heading(key);
    for (let k = 0; k < tiers; k++) {
      const model = k === tiers - 1 && rand01(`${key}:top`) > 0.6 ? 'red' : YARD_MODELS[(i + k) % YARD_MODELS.length]!;
      out.push(
        new Graphic({
          geometry: new Point({ longitude: p[0], latitude: p[1], z: k * CONTAINER_H_M, spatialReference: { wkid: 4326 } }),
          attributes: {
            objectId: stableOid(`yard3d:${key}:${k}`),
            ...(k === 0 ? { pkey: key } : {}),
            blockId: `${terminalId}-Y${i + 1}`,
            terminalId,
            tier: k,
            model,
            heading: hd,
          },
        }),
      );
    }
  });
  return out;
}

export function yardLayer(): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Yard stacks',
    source: yardGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'blockId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'tier', type: 'integer' },
      { name: 'model', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'relative-to-ground' } as never,
    renderer: {
      type: 'unique-value',
      field: 'model',
      uniqueValueInfos: YARD_MODELS.map((m) => ({
        value: m,
        symbol: {
          type: 'point-3d',
          symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/yard-container-${m}.glb` }, height: CONTAINER_H_M, anchor: 'bottom' }],
        },
      })),
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Yard block {blockId}', content: 'Terminal: {terminalId}' } as never,
  });
}

// ---------------------------------------------------------------------------
// Gates — the composite toll-naka GLB at each `gate3d:<GATE>` key, with its own
// surveyed heading so the canopy spans the access road correctly.
// ---------------------------------------------------------------------------

function gateGraphics(): Graphic[] {
  return keysOf('gate3d')
    .map((key) => {
      const p = pos(key);
      if (!p) return null;
      const gateId = key.slice('gate3d:'.length);
      const [terminalId] = gateId.split('-');
      return new Graphic({
        geometry: new Point({ longitude: p[0], latitude: p[1], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`gate3dm:${key}`),
          pkey: key,
          gateId,
          terminalId,
          // Rotate the toll-naka model a further 90° so its canopy spans the
          // access road across the quay bearing (not along it).
          heading: (heading(key) + 270) % 360,
        },
      });
    })
    .filter((g): g is Graphic => g != null);
}

export function gateLayer(): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Gates (toll naka)',
    source: gateGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'gateId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' } as never,
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/toll-naka.glb` }, height: 9, anchor: 'bottom' }],
      },
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Gate {gateId}', content: 'Terminal: {terminalId}' } as never,
  });
}

// ---------------------------------------------------------------------------
// Gate trucks — a short queue of container-truck GLBs trailing from each
// `truckroute:<T>` staging point, oriented along the route heading.
// ---------------------------------------------------------------------------

const TRUCKS_PER_ROUTE = 5;
const M_PER_DEG_LAT = 110_574;

function truckGraphics(): Graphic[] {
  const out: Graphic[] = [];
  keysOf('truckroute').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const [, terminalId] = key.split(':');
    const hd = heading(key, QUAY_BEARING);
    const brg = (hd * Math.PI) / 180;
    const mPerDegLon = 111_320 * Math.cos((p[1] * Math.PI) / 180);
    for (let k = 0; k < TRUCKS_PER_ROUTE; k++) {
      // Trail trucks back along the route bearing. Spacing exceeds the longest
      // truck GLB (container-truck ≈ 23 m at height 8) so queued trucks never overlap.
      const back = k * 30;
      const lng = p[0] - (Math.sin(brg) * back) / mPerDegLon;
      const lat = p[1] - (Math.cos(brg) * back) / M_PER_DEG_LAT;
      out.push(
        new Graphic({
          geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
          attributes: {
            objectId: stableOid(`truck3d:${key}:${k}`),
            routeKey: key,
            terminalId,
            model: k % 3 === 0 ? 'container-truck' : 'truck-realistic',
            heading: (hd + 180) % 360,
          },
        }),
      );
    }
  });
  return out;
}

export function truckLayer(): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Trucks (gate queues)',
    source: truckGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'routeKey', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' } as never,
    renderer: {
      type: 'unique-value',
      field: 'model',
      uniqueValueInfos: ['truck-realistic', 'container-truck'].map((model) => ({
        value: model,
        symbol: {
          type: 'point-3d',
          symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/${model}.glb` }, height: 8, anchor: 'bottom' }],
        },
      })),
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Truck ({terminalId})', content: 'Queued at the gate access road.' } as never,
  });
}

// ---------------------------------------------------------------------------
// Harbour tug — a single tug GLB out in the channel at the `tug` key.
// ---------------------------------------------------------------------------

function tugGraphics(): Graphic[] {
  const p = pos('tug');
  if (!p) return [];
  return [
    new Graphic({
      geometry: new Point({ longitude: p[0], latitude: p[1], spatialReference: { wkid: 4326 } }),
      attributes: { objectId: stableOid('tug3d'), pkey: 'tug', name: 'Harbour tug', heading: heading('tug', QUAY_BEARING) },
    }),
  ];
}

/**
 * Titles of the layers holding STATIC DUMMY vessels — the berthed hero ships and
 * the harbour tug. They are decorative hulls, not real traffic, so the live-AIS
 * overlay hides them along with the simulated fleet (see `isDummyVesselLayer`);
 * everything else here is port infrastructure and stays put.
 */
export const BERTHED_VESSEL_LAYER_TITLE = '3D · Berthed vessels';
export const TUG_LAYER_TITLE = '3D · Harbour tug';

/** True for a layer of decorative hulls that must not sit next to real AIS. */
export function isDummyVesselLayer(layer: { title?: string | null }): boolean {
  return layer.title === BERTHED_VESSEL_LAYER_TITLE || layer.title === TUG_LAYER_TITLE;
}

export function tugLayer(): FeatureLayer {
  return new FeatureLayer({
    title: TUG_LAYER_TITLE,
    source: tugGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' } as never,
    renderer: {
      type: 'simple',
      symbol: { type: 'point-3d', symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/boat-tug-a.glb` }, height: 18, anchor: 'bottom' }] },
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: '{name}', content: 'Standing by in the approach channel.' } as never,
  });
}

// ---------------------------------------------------------------------------
// Berthed hero vessels — a real container-ship GLB alongside each terminal,
// placed ON the quay line fitted from that terminal's cranes (not the raw
// `vessel:<T>` spot, which could drift off the wharf). Seated just seaward of the
// waterline at a quay slot clear of the live moored AIS ships (which take the
// centre/±180 m slots in fixtures), so hero and live hulls never intersect. The
// live moving AIS fleet is rendered separately in scene3d.
// ---------------------------------------------------------------------------

function berthedVesselGraphics(): Graphic[] {
  return TERMINALS.map((t, idx) => {
    const q = TERMINAL_QUAYS[t.id];
    // Hero ship sits toward the far end of the quay (+ half-length − a margin),
    // away from the live moored vessels clustered near the quay mid.
    const alongCentre = q.lengthM / 2 - 160;
    const centre = offsetMeters(q.mid, q.along, alongCentre);
    const seaward: [number, number] = [-q.landward[0], -q.landward[1]];
    const spot = offsetMeters(centre, seaward, 35);
    return new Graphic({
      geometry: new Point({ longitude: spot[0], latitude: spot[1], spatialReference: { wkid: 4326 } }),
      attributes: {
        objectId: stableOid(`berthedves:${t.id}`),
        pkey: `vessel:${t.id}`,
        terminalId: t.id,
        hull: idx % 2 === 0 ? 'a' : 'b',
        heading: q.bearingDeg, // hull runs along the quay
      },
    });
  });
}

export function berthedVesselLayer(): FeatureLayer {
  return new FeatureLayer({
    title: BERTHED_VESSEL_LAYER_TITLE,
    source: berthedVesselGraphics() as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'hull', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' } as never,
    renderer: {
      type: 'unique-value',
      field: 'hull',
      uniqueValueInfos: ['a', 'b'].map((h) => ({
        value: h,
        symbol: { type: 'point-3d', symbolLayers: [{ type: 'object', resource: { href: `${MODELS}/ship-cargo-${h}.glb` }, height: 40, anchor: 'bottom' }] },
      })),
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Berthed vessel', content: 'Alongside {terminalId}.' } as never,
  });
}

/** Build all port-infrastructure model layers, in draw order. */
export function portAssetLayers(): FeatureLayer[] {
  return [
    yardLayer(),
    craneLayer(),
    gateLayer(),
    truckLayer(),
    berthedVesselLayer(),
    tugLayer(),
  ];
}
