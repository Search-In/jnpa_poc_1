import { describe, it, expect } from 'vitest';
import {
  isLiveVesselId,
  liveBearing,
  liveLengthM,
  liveVesselGraphics2d,
  liveVesselGraphics3d,
  liveVesselLayer3d,
  LIVE_ID_PREFIX,
} from './liveVesselLayer';
import { spriteForVesselType } from '@/assets/registry';
import type { LiveVessel } from '@/types/domain';

const V: LiveVessel = {
  mmsi: '571902',
  vesselName: 'FENG HAI 66',
  imoNo: null,
  lat: 18.9271,
  lon: 72.8954,
  speedKnots: 8.4,
  course: 222,
  heading: 224,
  shipTypeCode: 70,
  shipTypeLabel: 'Cargo',
  destination: 'INNSA',
  flag: 'CN',
  length: 190,
  elapsedSeconds: 45,
};

describe('isLiveVesselId', () => {
  it('separates live graphics from placed/berthed asset ids', () => {
    expect(isLiveVesselId(`${LIVE_ID_PREFIX}571902`)).toBe(true);
    expect(isLiveVesselId('NSICT')).toBe(false);
    expect(isLiveVesselId(null)).toBe(false);
  });
});

/**
 * Every live vessel gets the SAME hull, sized and oriented from its own row — and that
 * hull is declared ONCE, on the layer renderer.
 *
 * The renderer is not a style detail. Symbolising each graphic individually meant 300+
 * separate glTF meshes with nothing shared, and scene navigation slowed to a crawl the
 * moment the overlay came on. One renderer + visual variables lets ArcGIS instance the
 * mesh, which is what the simulated fleet has always done.
 *
 * On the uniform hull itself: measured on a 314-vessel poll the feed supplies orientation
 * for 86% and length for 91%, but a class for very few — 152 'Other', 98 'Passenger
 * (HSC)', ~46 cargo — so a cargo silhouette on every row is presentational and is not to
 * be read as a vessel type. The AIS ship type is reported in the popup and the AIS Feed
 * table.
 */
describe('the 3D hull', () => {
  const withV = (over: Partial<LiveVessel>): LiveVessel => ({ ...V, ...over });
  const attrs = (v: LiveVessel) => liveVesselGraphics3d([v])[0].attributes;

  it('is declared once on the renderer, never per graphic', () => {
    // The regression guard. A `symbol` back on the graphic would silently restore the
    // 300-mesh behaviour with nothing else looking different.
    expect(liveVesselGraphics3d([V])[0].symbol).toBeFalsy();

    const renderer = liveVesselLayer3d().renderer as unknown as {
      type: string;
      symbol: { symbolLayers: { length: number; getItemAt: (i: number) => { type: string; resource?: unknown } } };
      visualVariables: { type: string; field: string; axis?: string }[];
    };
    expect(renderer.type).toBe('simple');
    const layer0 = renderer.symbol.symbolLayers.getItemAt(0);
    expect(layer0.type).toBe('object');
    expect(JSON.stringify(layer0.resource ?? {})).toMatch(/\.glb/);
  });

  it('drives orientation and size from visual variables, so one mesh serves all', () => {
    const vv = (liveVesselLayer3d().renderer as unknown as {
      visualVariables: { type: string; field: string; axis?: string }[];
    }).visualVariables;
    expect(vv.find((v) => v.type === 'rotation')).toMatchObject({ field: 'bearing', axis: 'heading' });
    expect(vv.find((v) => v.type === 'size')).toMatchObject({ field: 'hullH', axis: 'height' });
  });

  it('carries the same hull for every class the feed reports', () => {
    // Nothing in the graphic selects a model, so class cannot change the silhouette.
    for (const label of ['Cargo', 'Passenger (HSC)', 'Other', 'Unknown', 'Tanker']) {
      expect(attrs(withV({ shipTypeLabel: label })).hullH).toBe(attrs(V).hullH);
    }
  });

  it('falls back from heading to course — 95 of 140 headless rows still have one', () => {
    expect(liveBearing(withV({ heading: 224, course: 222 }))).toBe(224);
    expect(liveBearing(withV({ heading: 0, course: 222 }))).toBe(222);
  });

  it('orients by the AIS bearing, which is already the rotation-variable convention', () => {
    expect(attrs(V).bearing).toBe(224);
  });

  it('draws at 0° when the feed gives no bearing at all', () => {
    // Uniform with every other vessel by choice. Bearing is therefore not readable
    // per-vessel from the scene alone; the popup's Heading/Course fields are.
    const adrift = withV({ heading: 0, course: 0 });
    expect(liveBearing(adrift)).toBeNull();
    expect(attrs(adrift).bearing).toBe(0);
  });

  it('sizes bigger vessels bigger, from the reported LOA', () => {
    expect(attrs(withV({ length: 350 })).hullH).toBeGreaterThan(attrs(withV({ length: 60 })).hullH);
  });

  it('sizes from the reported LOA, and never renders an unknown length as larger', () => {
    expect(liveLengthM(withV({ length: 190 }))).toBe(190);
    expect(liveLengthM(withV({ length: null }))).toBeLessThan(liveLengthM(withV({ length: 190 })));
    expect(liveLengthM(withV({ length: 0 }))).toBeLessThan(liveLengthM(withV({ length: 190 })));
    // Clamped, so one absurd upstream value cannot fill the scene with a single hull.
    expect(liveLengthM(withV({ length: 99_999 }))).toBe(400);
  });
});

describe('liveVesselGraphics3d', () => {

  it('describes the vessel exactly as the 2D marker does, plus its render inputs', () => {
    const [three] = liveVesselGraphics3d([V]);
    const [two] = liveVesselGraphics2d([V]);
    // 3D adds `bearing` / `hullH` because its renderer reads them as visual variables.
    // Every DESCRIPTIVE field must still match, so the two renderers cannot drift into
    // describing the same vessel differently.
    const { bearing, hullH, ...described } = three.attributes as Record<string, unknown>;
    expect(bearing).toBeDefined();
    expect(hullH).toBeDefined();
    expect(described).toEqual(two.attributes);
  });
});

describe('liveVesselGraphics2d', () => {
  it('keys graphics with the LIVE- prefix and a stable objectId', () => {
    const [g] = liveVesselGraphics2d([V]);
    expect(g.attributes.vesselId).toBe(`${LIVE_ID_PREFIX}571902`);
    expect(g.attributes.objectId).toBe(liveVesselGraphics2d([V])[0].attributes.objectId);
  });

  it('carries the feed id under a name that is NOT "mmsi"', () => {
    const [g] = liveVesselGraphics2d([V]);
    expect(g.attributes.feedId).toBe('571902');
    expect(g.attributes).not.toHaveProperty('mmsi');
  });

  it('declares every popup attribute, with nulls rendered as dashes', () => {
    const [g] = liveVesselGraphics2d([{ ...V, imoNo: null, destination: null, flag: null, length: null }]);
    expect(g.attributes).toMatchObject({ imo: '—', destination: '—', flag: '—', lengthM: 0 });
  });

  it('places the graphic at the reported position', () => {
    const [g] = liveVesselGraphics2d([V]);
    expect(g.geometry).toMatchObject({ longitude: 72.8954, latitude: 18.9271 });
  });

  it('stacks a provenance ring UNDER the sprite, as AISMap does for a live vessel', () => {
    // Now that live traffic shares the simulated fleet's silhouette, the green LIVE ring
    // is the only thing left distinguishing the two on the flat map.
    const [ring, sprite] = liveVesselGraphics2d([V]);
    expect((ring.symbol as unknown as { style: string }).style).toBe('circle');
    // ArcGIS autocasts the hex string into a Color, so compare components. #22c55e.
    expect((ring.symbol as unknown as { outline: { color: { r: number; g: number; b: number } } })
      .outline.color).toMatchObject({ r: 34, g: 197, b: 94 });
    expect((sprite.symbol as unknown as { type: string }).type).toBe('picture-marker');
  });

  it('draws the SAME sprite the simulated fleet uses, not a bare marker', () => {
    // The overlay used to swap every hull for an amber triangle, so switching it on
    // changed what a vessel looked like as well as where the data came from.
    const [, sprite] = liveVesselGraphics2d([V]);
    const sym = sprite.symbol as unknown as { type: string; url: string };
    expect(sym.type).toBe('picture-marker');
    // The COLOURED container hull — the same one Uc3Adapter's corpus vessels get by
    // being typed 'Container Ship'. AIS says 'Cargo', which the sprite resolver does
    // not match on, so the label has to be translated or the vessel silently greys out.
    expect(sym.url).toBe(spriteForVesselType('Container Ship').url);
  });

  it('translates the AIS dialect so live and derived vessels look alike', () => {
    const url = (label: string) =>
      (liveVesselGraphics2d([{ ...V, shipTypeLabel: label }])[1].symbol as unknown as { url: string }).url;

    expect(url('Cargo')).toBe(spriteForVesselType('Container Ship').url);
    expect(url('Cargo (HSC)')).toBe(spriteForVesselType('Container Ship').url);
    expect(url('Tanker')).toBe(spriteForVesselType('Tanker').url);
    expect(url('Tug')).toBe(spriteForVesselType('Tug').url);
    // Nothing to translate to — the resolver's own generic fallback takes it.
    expect(url('Passenger (HSC)')).toBe(spriteForVesselType('Passenger (HSC)').url);
  });

  it('carries its symbol + popup on the sprite, so no layer renderer is needed', () => {
    const [ring, sprite] = liveVesselGraphics2d([V]);
    expect(sprite.symbol).toBeTruthy();
    expect(sprite.popupTemplate).toBeTruthy();
    // The ring is decoration: a popup on it too would open a second, identical balloon.
    expect(ring.popupTemplate).toBeFalsy();
  });

  it('rotates the sprite by heading (clockwise = a geographic bearing)', () => {
    const [, sprite] = liveVesselGraphics2d([V]);
    // `angle` on a marker symbol is clockwise from screen-up, so it maps 1:1 onto
    // the AIS heading — the FeatureLayer-renderer equivalent of
    // rotationType: 'geographic'.
    expect((sprite.symbol as unknown as { angle: number }).angle).toBe(224);
    const [, noHeading] = liveVesselGraphics2d([{ ...V, heading: 0 }]);
    expect((noHeading.symbol as unknown as { angle: number }).angle).toBe(222);
  });
});
