/**
 * Esri layers that render the what-if impact model INSIDE the walkthrough scene.
 *
 * Everything here is an ArcGIS `GraphicsLayer` on the same SceneView as the port
 * assets — no overlay canvas, no DOM annotation tracking. That keeps requirement
 * R-8 ("on the Esri stack, not bolt-on canvases") true for the immersive view,
 * and it means labels occlude, scale and depth-sort against the real 3D geometry
 * for free.
 *
 * Three visual channels, matching the spec's WHERE/HOW vocabulary:
 *  - a ground RING on each impacted asset            → where it lands
 *  - a floating LABEL with a leader line             → what happened, quantified
 *  - a mechanism-labelled EDGE between anchors       → how it propagated
 *
 * Accessibility: severity is never carried by hue alone. Every ring is paired
 * with a text label that states the impact in words, and the label is prefixed
 * with a severity glyph (▲ critical / ● warning / · info), satisfying the
 * CVD-safe rule in the edge-case register.
 */
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import type { Berth } from '@/types/domain';
import { asset3dPosition } from '@/map/scene3d';
import { placementStore } from '@/map/placementStore';
import { DOMAIN_COLOR } from '@/whatif/causalGraph';
import { tokens } from '@/theme/tokens';
import type { AssetImpact, ImpactEdge, ImpactSeverity } from './impactModel';

/** Ordinal ranking so the worst severity wins when impacts share an asset. */
const SEVERITY_ORDER: Record<ImpactSeverity, number> = {
  none: 0,
  info: 1,
  warn: 2,
  critical: 3,
};

export const VR_IMPACT_RING_TITLE = 'VR · Impact rings';
export const VR_IMPACT_LABEL_TITLE = 'VR · Impact labels';
export const VR_CAUSAL_EDGE_TITLE = 'VR · Causal edges';

/** Severity → colour + glyph. The glyph is what makes this CVD-safe. */
const SEVERITY_STYLE: Record<Exclude<ImpactSeverity, 'none'>, { color: string; glyph: string; ringSize: number }> = {
  critical: { color: tokens.bad, glyph: '▲', ringSize: 90 },
  warn: { color: tokens.warn, glyph: '●', ringSize: 70 },
  info: { color: tokens.accent, glyph: '·', ringSize: 55 },
};

/**
 * Resolve an impact to a ground position. Terminals / channel segments /
 * anchorages / PBG come from the shared `asset3dPosition()` map — the exact same
 * resolver the 2D map and the existing 3D highlight ring use, so the immersive
 * view rings the identical spot. Berths are resolved from their polygon.
 */
export function resolveImpactPosition(
  impact: AssetImpact,
  berths: Berth[],
  anchors: Map<string, [number, number]>
): [number, number] | null {
  if (impact.berthId) {
    const b = berths.find((x) => x.BERTH_ID === impact.berthId);
    if (b && b.GEOM.length) {
      const xs = b.GEOM.map((p) => p[0]);
      const ys = b.GEOM.map((p) => p[1]);
      return [xs.reduce((s, x) => s + x, 0) / xs.length, ys.reduce((s, y) => s + y, 0) / ys.length];
    }
    // A berth id the fixtures don't carry — fall back to its terminal.
    const terminal = impact.berthId.split('-')[0];
    const t = anchors.get(terminal);
    if (t) return t;
    return null;
  }
  return anchors.get(impact.assetId) ?? null;
}

/** Ground ring marking an impacted asset. */
function ringGraphic(lng: number, lat: number, impact: AssetImpact): Graphic {
  const style = SEVERITY_STYLE[impact.severity as Exclude<ImpactSeverity, 'none'>];
  return new Graphic({
    geometry: new Point({ longitude: lng, latitude: lat }),
    attributes: { assetId: impact.assetId, severity: impact.severity },
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        {
          type: 'icon',
          resource: { primitive: 'circle' },
          material: { color: [0, 0, 0, 0] },
          outline: { color: style.color, size: 3 },
          size: style.ringSize,
        },
      ],
    } as never,
  });
}

/**
 * Floating billboard label with a leader line down to the asset.
 *
 * `verticalOffset` in screen units keeps the label legible from any distance
 * (the 4-metre projector-legibility rule) while `maxWorldLength` stops it
 * drifting into orbit when the viewer is far away. `callout` draws the leader.
 */
function labelGraphic(lng: number, lat: number, impact: AssetImpact): Graphic {
  const style = SEVERITY_STYLE[impact.severity as Exclude<ImpactSeverity, 'none'>];
  const text = `${style.glyph} ${impact.label}\n${impact.headline}\n${impact.detail}`;
  return new Graphic({
    geometry: new Point({ longitude: lng, latitude: lat }),
    attributes: { assetId: impact.assetId },
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        {
          type: 'text',
          text,
          material: { color: tokens.text },
          halo: { color: tokens.panel, size: 2 },
          // 13pt is the projector-legibility floor used elsewhere in the app.
          size: 13,
          font: { family: 'Avenir Next, Segoe UI, sans-serif', weight: 'bold' },
        },
      ],
      verticalOffset: { screenLength: 70, maxWorldLength: 900, minWorldLength: 25 },
      callout: {
        type: 'line',
        size: 1.5,
        color: style.color,
        border: { color: tokens.panel },
      },
    } as never,
  });
}

/** Build the ring + label layers for a set of impacts. */
export function impactGraphics(
  impacts: AssetImpact[],
  berths: Berth[]
): { rings: Graphic[]; labels: Graphic[] } {
  const anchors = asset3dPosition();
  const rings: Graphic[] = [];
  const labels: Graphic[] = [];
  // One ring per physical spot: several impacts can land on the same terminal
  // (e.g. a berth outage AND a lost deep-draft window), and stacking identical
  // rings just thickens the outline. Labels are offset instead so both read.
  const ringed = new Set<string>();
  const labelCount = new Map<string, number>();

  for (const impact of impacts) {
    if (impact.severity === 'none') continue;
    const pos = resolveImpactPosition(impact, berths, anchors);
    if (!pos) continue;
    const key = `${pos[0].toFixed(6)},${pos[1].toFixed(6)}`;
    if (!ringed.has(key)) {
      ringed.add(key);
      rings.push(ringGraphic(pos[0], pos[1], impact));
    }
    // Fan stacked labels apart so the second impact on an asset stays readable.
    const n = labelCount.get(key) ?? 0;
    labelCount.set(key, n + 1);
    const g = labelGraphic(pos[0], pos[1], impact);
    if (n > 0) {
      const sym = g.symbol as unknown as { verticalOffset: { screenLength: number } };
      sym.verticalOffset.screenLength = 70 + n * 58;
    }
    labels.push(g);
  }
  return { rings, labels };
}

/**
 * Mechanism-labelled causal edges — the HOW channel. Each edge is a line from
 * one physical anchor to the next in the scenario's causal chain, raised above
 * the ground so it reads as a propagation path rather than a road, with the
 * mechanism text placed at its midpoint.
 */
export function causalEdgeGraphics(edges: ImpactEdge[]): Graphic[] {
  const anchors = asset3dPosition();
  const out: Graphic[] = [];

  for (const e of edges) {
    const from = anchors.get(e.fromAssetId);
    const to = anchors.get(e.toAssetId);
    if (!from || !to) continue;
    const color = DOMAIN_COLOR[e.domain] ?? tokens.accent;

    out.push(
      new Graphic({
        geometry: new Polyline({ paths: [[from, to]] }),
        attributes: { mechanism: e.mechanism },
        symbol: {
          type: 'line-3d',
          symbolLayers: [
            {
              type: 'line',
              size: 3,
              material: { color },
              // Dashed reads as "influence", not "route" — it must never be
              // mistaken for a navigable path in a marine scene.
              pattern: { type: 'style', style: 'dash' },
            },
          ],
        } as never,
      })
    );

    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    out.push(
      new Graphic({
        geometry: new Point({ longitude: mid[0], latitude: mid[1] }),
        attributes: { mechanism: e.mechanism },
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'text',
              text: e.mechanism,
              material: { color },
              halo: { color: tokens.panel, size: 2 },
              size: 12,
              font: { family: 'Avenir Next, Segoe UI, sans-serif', weight: 'bold' },
            },
          ],
          verticalOffset: { screenLength: 30, maxWorldLength: 700, minWorldLength: 15 },
        } as never,
      })
    );
  }
  return out;
}

/**
 * Ring the INDIVIDUAL glTF models at an impacted terminal — every STS crane on
 * that quay — rather than only the terminal centroid.
 *
 * This is what makes "the 3D assets are impacted" literally true in the
 * walkthrough: standing on the apron of a terminal whose berth just went out of
 * service, you see the actual crane models ringed beside you, not an abstract
 * marker floating over the yard. Positions come from the same surveyed
 * `positions.json` placements the crane layer renders from, so a ring can never
 * drift off its model.
 */
export function terminalModelRings(impacts: AssetImpact[]): Graphic[] {
  const affected = new Map<string, ImpactSeverity>();
  for (const i of impacts) {
    if (i.severity === 'none') continue;
    // Terminal-scoped impacts, plus the parent terminal of any berth impact.
    const terminal = i.kind === 'terminal' ? i.assetId : i.berthId?.split('-')[0];
    if (!terminal) continue;
    const prev = affected.get(terminal);
    if (!prev || SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[prev]) {
      affected.set(terminal, i.severity);
    }
  }
  if (!affected.size) return [];

  const out: Graphic[] = [];
  for (const key of placementStore.keysOfKind('crane')) {
    const terminal = key.split(':')[1];
    const severity = affected.get(terminal);
    if (!severity || severity === 'none') continue;
    const p = placementStore.get(key);
    if (!p) continue;
    const style = SEVERITY_STYLE[severity as Exclude<ImpactSeverity, 'none'>];
    out.push(
      new Graphic({
        geometry: new Point({ longitude: p.lng, latitude: p.lat }),
        attributes: { craneKey: key, severity },
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'icon',
              resource: { primitive: 'circle' },
              material: { color: [0, 0, 0, 0] },
              outline: { color: style.color, size: 2 },
              size: 22,
            },
          ],
        } as never,
      })
    );
  }
  return out;
}

/**
 * The three layers, created empty. `listMode: 'hide'` keeps them out of the
 * LayerList — they are view furniture driven by the scenario, not operator-
 * toggleable data layers.
 */
export function createImpactLayers(): {
  rings: GraphicsLayer;
  labels: GraphicsLayer;
  edges: GraphicsLayer;
} {
  return {
    rings: new GraphicsLayer({
      title: VR_IMPACT_RING_TITLE,
      listMode: 'hide',
      elevationInfo: { mode: 'on-the-ground' } as never,
    }),
    labels: new GraphicsLayer({
      title: VR_IMPACT_LABEL_TITLE,
      listMode: 'hide',
      elevationInfo: { mode: 'relative-to-ground', offset: 0 } as never,
    }),
    edges: new GraphicsLayer({
      title: VR_CAUSAL_EDGE_TITLE,
      listMode: 'hide',
      // Raised so the propagation path arcs above the quays and stays visible
      // from eye level instead of disappearing behind a container stack.
      elevationInfo: { mode: 'relative-to-ground', offset: 55 } as never,
    }),
  };
}
