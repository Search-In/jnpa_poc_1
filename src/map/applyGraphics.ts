/**
 * Smooth in-place FeatureLayer reconciliation (ported from the UC-2 map stack).
 * Because objectIds are stable per asset (`stableOid`), the FeatureLayerView
 * transitions changed features in place (attribute/geometry tween) instead of
 * delete-all + add-all — no whole-layer "blink" on every sim tick.
 */
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import type Graphic from '@arcgis/core/Graphic';

/** Stable, deterministic objectId from a logical key (vesselId, berthId, …). */
export function stableOid(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Reconcile a layer's features to `next` via a single applyEdits: present-in-both
 * → UPDATE, new → ADD, gone → DELETE. Skips no-op updates so unchanged features
 * aren't re-edited. Returns a promise.
 */
export async function applyGraphics(layer: FeatureLayer, next: Graphic[]): Promise<void> {
  // Best-effort, self-healing in-place update. If the layer isn't ready yet, is
  // tearing down, or applyEdits rejects, we swallow it — the next data tick
  // reconciles. Never let this surface as an unhandled promise rejection.
  try {
    const existing = await layer.queryFeatures();
    const oidField = layer.objectIdField;
    const prevByOid = new Map<number, Graphic>();
    for (const g of existing.features) prevByOid.set(g.attributes[oidField] as number, g);

    const addFeatures: Graphic[] = [];
    const updateFeatures: Graphic[] = [];
    const seen = new Set<number>();

    for (const g of next) {
      const id = g.attributes[oidField] as number;
      seen.add(id);
      const prev = prevByOid.get(id);
      if (!prev) addFeatures.push(g);
      else if (!attrsEqual(prev.attributes, g.attributes)) updateFeatures.push(g);
    }
    const deleteFeatures = existing.features.filter((g) => !seen.has(g.attributes[oidField] as number));

    if (!addFeatures.length && !updateFeatures.length && !deleteFeatures.length) return;
    await layer.applyEdits({ addFeatures, updateFeatures, deleteFeatures });
  } catch {
    /* layer not ready / destroyed / edit rejected — reconciled on the next tick */
  }
}
