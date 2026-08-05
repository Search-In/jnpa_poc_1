import { describe, it, expect } from 'vitest';
import {
  isLiveVesselId,
  liveVesselGraphics2d,
  liveVesselGraphics3d,
  LIVE_ID_PREFIX,
} from './liveVesselLayer';
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

describe('liveVesselGraphics3d', () => {
  /**
   * Live traffic must stay a flat marker in the 3D scene too. A glTF hull would
   * imply a class, size and orientation the AIS feed does not give us — heading
   * is frequently absent and length is often 0/null.
   */
  it('draws a flat icon, never a glTF ship model', () => {
    const [g] = liveVesselGraphics3d([V]);
    // ArcGIS autocasts the plain symbol into a PointSymbol3D whose symbolLayers
    // is a Collection, so read it through getItemAt rather than by index.
    const layers = (
      g.symbol as unknown as {
        symbolLayers: { length: number; getItemAt: (i: number) => { type: string; resource?: unknown } };
      }
    ).symbolLayers;
    expect(layers.length).toBe(1);
    const layer0 = layers.getItemAt(0);
    expect(layer0.type).toBe('icon');
    expect(JSON.stringify(layer0.resource ?? {})).not.toMatch(/\.glb/);
  });

  it('keys and describes the graphic exactly as the 2D marker does', () => {
    const [three] = liveVesselGraphics3d([V]);
    const [two] = liveVesselGraphics2d([V]);
    expect(three.attributes).toEqual(two.attributes);
    expect(three.popupTemplate).toBeTruthy();
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

  it('carries its own symbol + popup, so no layer renderer is needed', () => {
    const [g] = liveVesselGraphics2d([V]);
    expect(g.symbol).toBeTruthy();
    expect(g.popupTemplate).toBeTruthy();
  });

  it('rotates the bow-up triangle by heading (clockwise = a geographic bearing)', () => {
    const [g] = liveVesselGraphics2d([V]);
    // `angle` on a marker symbol is clockwise from screen-up, so it maps 1:1 onto
    // the AIS heading — the FeatureLayer-renderer equivalent of
    // rotationType: 'geographic'.
    expect((g.symbol as unknown as { angle: number }).angle).toBe(224);
    const [noHeading] = liveVesselGraphics2d([{ ...V, heading: V.course }]);
    expect((noHeading.symbol as unknown as { angle: number }).angle).toBe(222);
  });
});
