/**
 * portAssets2d — the flat-map twin of the 3D port-infrastructure fleet. The
 * ArcGIS 2D MapView cannot render glTF `object` symbols, so the same assets
 * placed from `data/positions.json` (cranes, yard blocks, gates, gate trucks,
 * the harbour tug and berthed ships) are drawn here as top-down markers at their
 * EXACT surveyed coordinates — a 1:1 planimetric read of the 3D scene.
 *
 * One source of truth: both the 3D models (portAssets3d.ts) and these 2D markers
 * read the SAME placement keys from the placement store, so a positions.json edit
 * moves the asset identically in both views.
 */
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import { placementStore } from './placementStore';
import { QUAY_BEARING } from './portGeometry';
import { tokens } from '../theme/tokens';
import { CRAFT_SPRITES, VESSEL_SPRITES } from '../assets/registry';

const QUAY_HEADING = (QUAY_BEARING + 90) % 360;

function keysOf(kind: string): string[] {
  return placementStore.keysOfKind(kind);
}
function pos(key: string): [number, number] | null {
  const p = placementStore.get(key);
  return p ? [p.lng, p.lat] : null;
}
function heading(key: string, fallback: number): number {
  const p = placementStore.get(key);
  return p?.heading != null ? p.heading : fallback;
}

function pt(p: [number, number]): Point {
  return new Point({ longitude: p[0], latitude: p[1], spatialReference: { wkid: 4326 } });
}

// ---- per-asset top-down symbols --------------------------------------------

/** STS crane — a square gantry footprint straddling the quay edge. */
function craneSymbol(angle: number) {
  return {
    type: 'simple-marker' as const,
    style: 'square' as const,
    color: [255, 209, 102, 0.95], // gantry yellow
    size: 11,
    angle,
    outline: { color: tokens.text, width: 0.75 },
  };
}

/** Yard block — a small dark container-stack square. */
function yardSymbol(color: [number, number, number], angle: number) {
  return {
    type: 'simple-marker' as const,
    style: 'square' as const,
    color: [...color, 0.9] as number[],
    size: 8,
    angle,
    outline: { color: [255, 255, 255, 0.6], width: 0.5 },
  };
}

/** Gate / toll naka — a diamond on the access road. */
function gateSymbol(angle: number) {
  return {
    type: 'simple-marker' as const,
    style: 'diamond' as const,
    color: tokens.good,
    size: 12,
    angle,
    outline: { color: '#ffffff', width: 1 },
  };
}

/** Truck — a small triangle pointing along its route heading. */
function truckSymbol(angle: number) {
  return {
    type: 'simple-marker' as const,
    style: 'triangle' as const,
    color: [26, 115, 194, 0.9],
    size: 7,
    angle,
    outline: { color: '#ffffff', width: 0.5 },
  };
}

const YARD_COLORS: Record<'red' | 'green' | 'blue', [number, number, number]> = {
  red: [216, 48, 32],
  green: [47, 158, 65],
  blue: [0, 121, 193],
};
const YARD_CYCLE = ['red', 'green', 'blue'] as const;

// ---- layer builder ---------------------------------------------------------

/**
 * A GraphicsLayer of the static port infrastructure for the 2D map, placed from
 * positions.json. Rebuilt from the placement store on demand.
 */
export function buildPortAssets2dLayer(): GraphicsLayer {
  const layer = new GraphicsLayer({ title: 'Port assets' });
  const g: Graphic[] = [];

  // Yard blocks — colour cycles by index (matches the 3D block liveries).
  keysOf('yard').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const i = Number(key.split(':')[2]) || 0;
    const model = YARD_CYCLE[i % YARD_CYCLE.length]!;
    g.push(
      new Graphic({
        geometry: pt(p),
        attributes: { pkey: key, kind: 'yard', label: `Yard ${key.slice('yard:'.length)}` },
        symbol: yardSymbol(YARD_COLORS[model], heading(key, QUAY_HEADING)),
        popupTemplate: { title: 'Yard block', content: '{label}' },
      }),
    );
  });

  // STS cranes.
  keysOf('crane').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const [, terminalId, idx] = key.split(':');
    g.push(
      new Graphic({
        geometry: pt(p),
        attributes: { pkey: key, kind: 'crane', label: `${terminalId}-STS${Number(idx) + 1}` },
        symbol: craneSymbol(heading(key, QUAY_HEADING)),
        popupTemplate: { title: 'STS crane {label}', content: 'Terminal: ' + terminalId },
      }),
    );
  });

  // Gates (toll naka).
  keysOf('gate3d').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const gateId = key.slice('gate3d:'.length);
    g.push(
      new Graphic({
        geometry: pt(p),
        attributes: { pkey: key, kind: 'gate', label: gateId },
        symbol: gateSymbol(heading(key, QUAY_HEADING)),
        popupTemplate: { title: 'Gate {label}', content: 'Terminal access / toll naka.' },
      }),
    );
  });

  // Gate-queue trucks — a short trail back along each route bearing.
  const M_PER_DEG_LAT = 110_574;
  keysOf('truckroute').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const hd = heading(key, QUAY_BEARING);
    const brg = (hd * Math.PI) / 180;
    const mPerDegLon = 111_320 * Math.cos((p[1] * Math.PI) / 180);
    for (let k = 0; k < 5; k++) {
      const back = k * 14;
      const lng = p[0] - (Math.sin(brg) * back) / mPerDegLon;
      const lat = p[1] - (Math.cos(brg) * back) / M_PER_DEG_LAT;
      g.push(
        new Graphic({
          geometry: pt([lng, lat]),
          attributes: { pkey: key, kind: 'truck', label: key.slice('truckroute:'.length) },
          symbol: truckSymbol(hd),
          popupTemplate: { title: 'Gate truck', content: 'Queue at {label}.' },
        }),
      );
    }
  });

  // Harbour tug — the tug sprite out in the channel.
  const tug = pos('tug');
  if (tug) {
    g.push(
      new Graphic({
        geometry: pt(tug),
        attributes: { pkey: 'tug', kind: 'tug', label: 'Harbour tug' },
        symbol: {
          type: 'picture-marker',
          url: CRAFT_SPRITES.tug.url,
          width: CRAFT_SPRITES.tug.width,
          height: CRAFT_SPRITES.tug.height,
          angle: heading('tug', QUAY_BEARING),
        },
        popupTemplate: { title: '{label}', content: 'Standing by in the approach channel.' },
      }),
    );
  }

  // Berthed hero vessels — the container sprite alongside each terminal.
  keysOf('vessel').forEach((key) => {
    const p = pos(key);
    if (!p) return;
    const terminalId = key.slice('vessel:'.length);
    g.push(
      new Graphic({
        geometry: pt(p),
        attributes: { pkey: key, kind: 'berthed', label: terminalId },
        symbol: {
          type: 'picture-marker',
          url: VESSEL_SPRITES.container.url,
          width: VESSEL_SPRITES.container.width,
          height: VESSEL_SPRITES.container.height,
          angle: heading(key, (QUAY_HEADING + 90) % 360),
        },
        popupTemplate: { title: 'Berthed vessel', content: 'Alongside {label}.' },
      }),
    );
  });

  layer.addMany(g);
  return layer;
}
