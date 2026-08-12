/**
 * Live-AIS map layers — the real MarineTraffic-sourced traffic overlay, in both
 * renderers. Built once per map, then populated from `useLiveVessels`.
 *
 * 2D draws an amber triangle whose bow points along the AIS heading. 3D draws a glTF
 * hull, one model for every vessel, sized from the reported LOA — see `liveSymbol3d`.
 *
 * Both layers are `GraphicsLayer`s, populated by removeAll()/addMany() per poll,
 * with the symbol on each GRAPHIC rather than on a layer renderer. That matches
 * how the 2D map draws everything else, and avoids the client-side FeatureLayer
 * failure modes: a load/applyEdits race that silently drops an early poll, and
 * attributes vanishing when they are missing from `fields`. A poll is a few
 * hundred points, so a full redraw is cheap.
 *
 * Live graphics are keyed `LIVE-<mmsi>` so a click can be told apart from a
 * berthed/simulated asset id — see the click guard in PortScene. Nothing here
 * goes through the placement/asset store: live vessels are not placed assets and
 * looking them up there would open the "Move & rotate" editor instead of the
 * info popup.
 */
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import { applyGraphics, stableOid } from './applyGraphics';
import { spriteForVesselType } from '@/assets/registry';
import type { LiveVessel } from '@/types/domain';

/** Layer title (both renderers). */
export const LIVE_LAYER_TITLE = 'Live AIS vessels (MarineTraffic)';

/** Prefix on every live graphic id, so a click can skip the placement lookup. */
export const LIVE_ID_PREFIX = 'LIVE-';

/** True for an asset id that belongs to a live-AIS graphic. */
export function isLiveVesselId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LIVE_ID_PREFIX);
}

/**
 * HOW A LIVE VESSEL IS DRAWN IN 3D.
 *
 * ONE hull model for every live vessel, matching the simulated fleet beside it. The scene
 * originally drew live traffic as flat screen-facing dots while synthetic vessels got
 * textured glTF hulls, which made the real traffic read as the less real of the two.
 *
 * A note for whoever reads this next, because the history is easy to misread as an
 * oversight. Measured on a 314-vessel poll, the feed supplies orientation for 86% and
 * length for 91% — both drawn faithfully below — but a CLASS for very few: 152 'Other',
 * 98 'Passenger (HSC)', 10 'Unknown', and only ~46 cargo. So a cargo hull on every row is
 * a deliberate presentational choice, made knowingly: the map says "a vessel is here, this
 * long, heading this way", and the hull silhouette is not to be read as a vessel type.
 * The AIS ship type is reported honestly in the popup and in the AIS Feed table, which is
 * where a class question gets answered.
 *
 * The same applies to the ~14% with neither heading nor course: they are drawn at 0°
 * along with everything else, so bearing is not readable per-vessel from the scene alone.
 * `Heading (°T)` / `Course (°T)` in the popup are the authority.
 */

/** Orientation the feed can actually support: heading, else course, else none. */
export function liveBearing(v: LiveVessel): number | null {
  if (typeof v.heading === 'number' && v.heading > 0) return v.heading;
  if (typeof v.course === 'number' && v.course > 0) return v.course;
  return null;
}

/** The one hull every live vessel is drawn with — the simulated fleet's own model. */
const LIVE_HULL = '/models/container-ship.glb';

/**
 * Metres of hull to draw. Uses the reported LOA where there is one; the fallback is
 * deliberately modest so an unknown-length vessel never renders larger than a measured
 * one and reads as bigger than it was reported to be.
 */
export function liveLengthM(v: LiveVessel): number {
  const loa = v.length;
  return typeof loa === 'number' && loa > 0 ? Math.min(400, Math.max(20, loa)) : 40;
}

/**
 * Attributes shared by both renderers. `vesselId` carries the LIVE- prefix;
 * `feedId` keeps the raw value for display.
 *
 * ⚠ `feedId` is labelled "Feed id", never "MMSI": the gateway fills it from
 * MarineTraffic's SHIP_ID, so showing it as an MMSI would be wrong.
 */
function liveAttributes(v: LiveVessel): Record<string, string | number> {
  return {
    objectId: stableOid(`${LIVE_ID_PREFIX}${v.mmsi}`),
    vesselId: `${LIVE_ID_PREFIX}${v.mmsi}`,
    feedId: v.mmsi,
    name: v.vesselName,
    type: v.shipTypeLabel,
    typeCode: v.shipTypeCode,
    imo: v.imoNo ?? '—',
    sog: v.speedKnots,
    cog: v.course,
    heading: v.heading,
    destination: v.destination ?? '—',
    flag: v.flag ?? '—',
    lengthM: v.length ?? 0,
    ageSec: v.elapsedSeconds ?? 0,
  };
}

/** Popup rows — identical in 2D and 3D so the two maps describe a vessel alike. */
const LIVE_POPUP_FIELDS = [
  { fieldName: 'type', label: 'AIS ship type' },
  { fieldName: 'sog', label: 'Speed (kn)' },
  { fieldName: 'cog', label: 'Course (°T)' },
  { fieldName: 'heading', label: 'Heading (°T)' },
  { fieldName: 'destination', label: 'Destination' },
  { fieldName: 'flag', label: 'Flag' },
  { fieldName: 'lengthM', label: 'Length (m)' },
  { fieldName: 'imo', label: 'IMO' },
  { fieldName: 'ageSec', label: 'Position age (s)' },
  // Labelled "Feed id", NOT "MMSI" — see liveAttributes().
  { fieldName: 'feedId', label: 'Feed id (MarineTraffic)' },
];

/**
 * Popup template. No `actions`: the scene's Focus-camera / Clear actions resolve
 * an id through the placement store, which holds no live vessel.
 */
const LIVE_POPUP = {
  title: '🛰️ {name} · live AIS',
  content: [{ type: 'fields', fieldInfos: LIVE_POPUP_FIELDS }],
};

// ---- 2D --------------------------------------------------------------------

/**
 * AIS ship-type label → the vocabulary `spriteForVesselType` matches on.
 *
 * The two speak different dialects, and passing the AIS label straight through quietly
 * lost the match: MarineTraffic says 'Cargo', the resolver tests for 'container' /
 * 'bulk' / 'carrier' / 'tank', so every live cargo vessel fell to the GREY generic hull
 * while the corpus fleet beside it — typed 'Container Ship' by Uc3Adapter — got the
 * coloured container sprite. Same berth, same class of ship, two different silhouettes,
 * decided by a string nobody had compared.
 *
 * JNPA is a container port and MarineTraffic's 'Cargo' bucket is its general
 * cargo/container class, so that is the sprite it earns. Anything with no equivalent
 * falls through unchanged and the resolver's own generic fallback handles it.
 */
function spriteTypeFor(v: LiveVessel): string {
  const label = (v.shipTypeLabel || '').toLowerCase();
  if (label.includes('cargo')) return 'Container Ship';
  if (label.includes('tanker')) return 'Tanker';
  if (label.includes('tug') || label.includes('tender')) return 'Tug';
  return v.shipTypeLabel || '';
}

/**
 * The vessel SPRITE, rotated to the vessel's AIS bearing — the same picture-marker the
 * simulated fleet uses, so switching the overlay on no longer changes what a vessel
 * looks like. It was a bare amber triangle, which made real traffic read as a different
 * class of thing from the hulls it replaced.
 *
 * `angle` on a marker symbol is measured CLOCKWISE from screen-up, which for a bow-up
 * glyph is exactly a geographic bearing — the same 1:1 mapping AISMap relies on. (The
 * equivalent on a FeatureLayer *renderer* is `rotationType: 'geographic'`; its default,
 * 'arithmetic', measures counter-clockwise from east and points every vessel the wrong
 * way.)
 *
 * The sprite is chosen from the AIS ship-type label through the SAME resolver the
 * simulated fleet uses, so 'Cargo' picks the cargo silhouette and anything unrecognised
 * falls through to the generic hull rather than asserting a class.
 */
function liveSymbol2d(v: LiveVessel) {
  const sprite = spriteForVesselType(spriteTypeFor(v));
  return {
    type: 'picture-marker' as const,
    url: sprite.url,
    width: sprite.width,
    height: sprite.height,
    angle: liveBearing(v) ?? 0,
  };
}

/**
 * The green provenance ring drawn UNDER every live sprite — the same badge AISMap puts
 * on a `SOURCE: 'live'` vessel. Without it the overlay's vessels would be indistinguishable
 * from simulated ones now that they share a silhouette, which is the opposite of what the
 * provenance work is for.
 */
function liveRing2d() {
  return {
    type: 'simple-marker' as const,
    style: 'circle' as const,
    color: [0, 0, 0, 0],
    size: 24,
    outline: { color: '#22c55e', width: 2 },
  };
}

/**
 * Point graphics for the 2D map, each carrying its own symbol and popup. Pure.
 *
 * Symbols live on the GRAPHIC rather than on a layer renderer because the 2D map
 * draws every layer as a GraphicsLayer (vessels, berths, port assets all do),
 * and a client-side FeatureLayer here would add a load/applyEdits race for no
 * benefit: it silently drops undeclared attributes, and its first `applyEdits`
 * is discarded if the layer has not finished loading when a poll lands.
 */
export function liveVesselGraphics2d(vessels: LiveVessel[]): Graphic[] {
  return vessels.flatMap((v) => {
    const geometry = new Point({ longitude: v.lon, latitude: v.lat });
    const attributes = liveAttributes(v);
    return [
      // Ring first so it sits UNDER the sprite, matching AISMap's stacking order.
      new Graphic({ geometry, attributes, symbol: liveRing2d() as never }),
      new Graphic({
        geometry,
        attributes,
        symbol: liveSymbol2d(v) as never,
        popupTemplate: LIVE_POPUP as never,
      }),
    ];
  });
}

/** The 2D layer — populated by `renderLiveVessels2d`. */
export function liveVesselLayer2d(): GraphicsLayer {
  return new GraphicsLayer({ title: LIVE_LAYER_TITLE, visible: false });
}

/** Replace the 2D layer's contents with the current picture. */
export function renderLiveVessels2d(layer: GraphicsLayer, vessels: LiveVessel[]): void {
  layer.removeAll();
  layer.addMany(liveVesselGraphics2d(vessels));
}

// ---- 3D --------------------------------------------------------------------

/**
 * Height of the drawn hull, in metres of model extent. ArcGIS scales the other axes to
 * keep the mesh proportional, so driving this from LOA keeps big ships big.
 */
function hullHeightM(v: LiveVessel): number {
  return Math.max(20, liveLengthM(v) * 0.16);
}

/**
 * Graphics for the 3D scene.
 *
 * NO per-graphic `symbol`, and that is the point. Each graphic carries `bearing` and
 * `hullH` as ATTRIBUTES, and the layer renderer turns them into one instanced mesh — see
 * `liveVesselLayer3d`.
 */
export function liveVesselGraphics3d(vessels: LiveVessel[]): Graphic[] {
  return vessels.map(
    (v) =>
      new Graphic({
        geometry: new Point({ longitude: v.lon, latitude: v.lat }),
        attributes: {
          ...liveAttributes(v),
          // 0° where the feed gives neither heading nor course. Uniform with the rest by
          // choice; the popup's Heading/Course fields remain the authority on bearing.
          bearing: liveBearing(v) ?? 0,
          hullH: hullHeightM(v),
        },
      }),
  );
}

/**
 * The 3D layer — a client-side FeatureLayer with ONE renderer, not a GraphicsLayer of
 * individually symbolised points.
 *
 * WHY THIS IS A FEATURELAYER. It was a GraphicsLayer carrying a PointSymbol3D per
 * graphic, which is fine for a flat icon and ruinous for a glTF hull: 300+ distinct
 * symbol definitions mean 300+ meshes with nothing shared between them, and navigation
 * in the scene slowed to a crawl the moment the overlay came on. A renderer declares the
 * hull ONCE and ArcGIS instances it across every feature — exactly what the simulated
 * fleet has always done (`scene3d.ts::vesselLayer`), which is why ~110 synthetic vessels
 * were smooth while 314 real ones were not.
 *
 * Per-feature orientation and size survive the move as VISUAL VARIABLES reading the
 * `bearing` / `hullH` attributes, so nothing about what is drawn changes — only how many
 * times the mesh is uploaded.
 *
 * `listMode: 'hide'` keeps it OUT of the scene's LayerList on purpose: its visibility is
 * owned by the toolbar toggle, which also hides the simulated fleet. A second checkbox in
 * the LayerList would let an operator show an un-polled empty layer, or reveal both
 * fleets at once.
 */
export function liveVesselLayer3d(): FeatureLayer {
  return new FeatureLayer({
    title: LIVE_LAYER_TITLE,
    source: [],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    visible: false,
    listMode: 'hide',
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'vesselId', type: 'string' },
      { name: 'feedId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'typeCode', type: 'double' },
      { name: 'imo', type: 'string' },
      { name: 'sog', type: 'double' },
      { name: 'cog', type: 'double' },
      { name: 'heading', type: 'double' },
      { name: 'destination', type: 'string' },
      { name: 'flag', type: 'string' },
      { name: 'lengthM', type: 'double' },
      { name: 'ageSec', type: 'double' },
      { name: 'bearing', type: 'double' },
      { name: 'hullH', type: 'double' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          { type: 'object', resource: { href: LIVE_HULL }, anchor: 'bottom' },
        ],
      },
      visualVariables: [
        // `axis: 'heading'` is degrees clockwise from north — the same convention as the
        // AIS bearing, so the value is passed through unconverted.
        { type: 'rotation', field: 'bearing', axis: 'heading' },
        { type: 'size', field: 'hullH', axis: 'height' },
      ],
    } as never,
    popupTemplate: LIVE_POPUP as never,
    elevationInfo: { mode: 'relative-to-ground', offset: 0 } as never,
  });
}

/**
 * Reconcile the 3D layer to the current picture.
 *
 * In-place via `applyGraphics` (stable objectIds from the feed id), so a poll tweens the
 * hulls that moved instead of dropping and re-uploading all 300+ meshes — the same
 * reconciliation the simulated fleet uses on every sim tick.
 */
export function renderLiveVessels3d(layer: FeatureLayer, vessels: LiveVessel[]): void {
  void applyGraphics(layer, liveVesselGraphics3d(vessels));
}
