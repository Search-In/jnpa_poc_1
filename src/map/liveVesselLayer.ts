/**
 * Live-AIS map layers — the real MarineTraffic-sourced traffic overlay, in both
 * renderers. Built once per map, then populated from `useLiveVessels`.
 *
 * Live traffic is drawn as FLAT MARKERS in both renderers — an amber triangle on
 * the 2D map (the bow points along the AIS heading) and an amber dot in the 3D
 * scene. No ship models: a glTF hull would assert a class, size and orientation
 * the feed does not supply.
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
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import { stableOid } from './applyGraphics';
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
 * Live traffic is drawn as flat markers in BOTH renderers — never as 3D ship
 * models. A glTF hull implies a class, size and orientation the AIS feed does
 * not actually give us (`heading` is frequently absent, `length` is often 0 or
 * null), so a model would be dressing invented detail as observation. A marker
 * says exactly what the feed knows: a vessel is here.
 *
 * Amber, matching the marker language already on the map.
 */
const LIVE_COLOR = '#e8a33d';
const LIVE_OUTLINE = '#ffffff';

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
 * The bow-up triangle, rotated to the vessel's AIS heading.
 *
 * `angle` on a marker symbol is measured CLOCKWISE from screen-up, which for a
 * bow-up glyph is exactly a geographic bearing — the same 1:1 mapping the
 * simulated fleet's picture-markers rely on in AISMap. (The equivalent on a
 * FeatureLayer *renderer* is `rotationType: 'geographic'`; its default,
 * 'arithmetic', measures counter-clockwise from east and points every vessel the
 * wrong way.)
 */
function liveSymbol2d(v: LiveVessel) {
  return {
    type: 'simple-marker' as const,
    style: 'triangle' as const,
    size: 10,
    color: LIVE_COLOR,
    outline: { color: LIVE_OUTLINE, width: 1 },
    angle: v.heading,
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
  return vessels.map(
    (v) =>
      new Graphic({
        geometry: new Point({ longitude: v.lon, latitude: v.lat }),
        attributes: liveAttributes(v),
        symbol: liveSymbol2d(v) as never,
        popupTemplate: LIVE_POPUP as never,
      }),
  );
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
 * Graphics for the 3D scene: a flat screen-sized dot, so live traffic reads the
 * same from any camera angle — explicitly NOT a glTF ship model (see the
 * LIVE_COLOR note above). A circle rather than 2D's triangle because a
 * screen-facing icon has no meaningful bearing to point along.
 *
 * Each carries its own symbol and popupTemplate, so the SceneView opens the info
 * popup on click without a layer renderer or an asset lookup.
 */
export function liveVesselGraphics3d(vessels: LiveVessel[]): Graphic[] {
  return vessels.map(
    (v) =>
      new Graphic({
        geometry: new Point({ longitude: v.lon, latitude: v.lat }),
        attributes: liveAttributes(v),
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'icon',
              resource: { primitive: 'circle' },
              size: 10,
              material: { color: LIVE_COLOR },
              outline: { color: LIVE_OUTLINE, size: 1 },
            },
          ],
          // Lifted clear of the sea surface so a shallow camera tilt doesn't let
          // the water swallow the marker. No callout line — there is no hull
          // underneath for it to point at.
          verticalOffset: { screenLength: 0, minWorldLength: 25 },
        } as never,
        popupTemplate: LIVE_POPUP as never,
      }),
  );
}

/**
 * The 3D layer — populated by removeAll()/addMany(), see the module note.
 *
 * `listMode: 'hide'` keeps it OUT of the scene's LayerList on purpose: its
 * visibility is owned by the toolbar toggle, which also hides the simulated
 * fleet. A second checkbox in the LayerList would let an operator show an
 * un-polled empty layer, or reveal both fleets at once.
 */
export function liveVesselLayer3d(): GraphicsLayer {
  return new GraphicsLayer({
    title: LIVE_LAYER_TITLE,
    visible: false,
    listMode: 'hide',
    elevationInfo: { mode: 'relative-to-ground', offset: 0 } as never,
  });
}

/** Replace the 3D layer's contents with the current picture. */
export function renderLiveVessels3d(layer: GraphicsLayer, vessels: LiveVessel[]): void {
  layer.removeAll();
  layer.addMany(liveVesselGraphics3d(vessels));
}
