import { describe, it, expect } from 'vitest';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import { setPortAssets2dVisible } from './portAssets2d';

/**
 * The 2D map draws every port asset in ONE GraphicsLayer, so infrastructure and
 * the decorative hulls have to be driven graphic-by-graphic. A plain array
 * stands in for the layer's Collection — both expose forEach.
 */
function fakeLayer(kinds: (string | undefined)[]) {
  const graphics = kinds.map((kind) => ({ attributes: kind ? { kind } : undefined, visible: true }));
  return { layer: { graphics } as unknown as GraphicsLayer, graphics };
}

const INFRA = ['crane', 'yard', 'gate', 'truck'];
const HULLS = ['berthed', 'tug'];

describe('setPortAssets2dVisible', () => {
  it('unchecking Port Assets hides infrastructure but NOT the vessels', () => {
    const { layer, graphics } = fakeLayer([...INFRA, ...HULLS]);
    setPortAssets2dVisible(layer, { infrastructure: false, vessels: true });
    expect(graphics.slice(0, INFRA.length).every((g) => g.visible)).toBe(false);
    expect(graphics.slice(INFRA.length).every((g) => g.visible)).toBe(true);
  });

  it('hides the decorative hulls (live AIS on) while the port stays drawn', () => {
    const { layer, graphics } = fakeLayer([...INFRA, ...HULLS]);
    setPortAssets2dVisible(layer, { infrastructure: true, vessels: false });
    expect(graphics.slice(0, INFRA.length).every((g) => g.visible)).toBe(true);
    expect(graphics.slice(INFRA.length).some((g) => g.visible)).toBe(false);
  });

  it('restores everything when both halves are on', () => {
    const { layer, graphics } = fakeLayer([...INFRA, ...HULLS]);
    setPortAssets2dVisible(layer, { infrastructure: false, vessels: false });
    setPortAssets2dVisible(layer, { infrastructure: true, vessels: true });
    expect(graphics.every((g) => g.visible)).toBe(true);
  });

  it('treats a graphic with no attributes as infrastructure', () => {
    const { layer, graphics } = fakeLayer([undefined]);
    setPortAssets2dVisible(layer, { infrastructure: false, vessels: true });
    expect(graphics[0].visible).toBe(false);
  });
});
