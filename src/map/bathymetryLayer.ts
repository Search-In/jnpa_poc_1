/**
 * Bathymetry soundings overlay — client FeatureLayer populated from the UC-3
 * bathymetry API (`fetchBathymetryOverlaySoundings`). Real georeferenced
 * soundings only; no local/mock pack.
 *
 * Mirrors the sea-channel pattern (empty FeatureLayer + applyGraphics): cyan
 * for normal soundings, crimson for above-design (shoal). Off by default;
 * toggled from the 2D "Channel / Bathymetry" checkbox and the 3D Layers list.
 */

import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import { tokens } from '@/theme/tokens';
import { stableOid } from './applyGraphics';
import type { BathymetrySounding, BathymetrySurvey } from '@/types/domain';
import { soundingsWithPosition } from '@/data/uc3/bathymetry';

function popupFields(rows: Array<{ fieldName: string; label: string }>) {
  return [
    {
      type: 'fields',
      fieldInfos: rows.map((r) => ({ fieldName: r.fieldName, label: r.label })),
    },
  ];
}

/** Empty client FeatureLayer for UC-3 bathymetry soundings. */
export function bathymetryLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Bathymetry soundings',
    source: [] as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    visible: false,
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'soundingId', type: 'integer' },
      { name: 'surveyId', type: 'integer' },
      { name: 'depthM', type: 'double' },
      { name: 'aboveDesign', type: 'integer' },
      { name: 'drawingNo', type: 'string' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'aboveDesign',
      uniqueValueInfos: [
        {
          value: 1,
          label: 'Above design (shoal)',
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            size: 4,
            color: [220, 38, 38, 0.9],
            outline: { color: [127, 29, 29, 0.85], width: 0.5 },
          },
        },
        {
          value: 0,
          label: 'Depth sounding',
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            size: 3,
            color: [14, 165, 233, 0.55],
            outline: { width: 0 },
          },
        },
      ],
    } as never,
    popupTemplate: {
      title: 'Bathymetry · {drawingNo}',
      content: popupFields([
        { fieldName: 'depthM', label: 'Depth (m below CD)' },
        { fieldName: 'aboveDesign', label: 'Above design (1 = shoal)' },
        { fieldName: 'drawingNo', label: 'Drawing' },
        { fieldName: 'surveyId', label: 'Survey id' },
      ]),
    } as never,
    elevationInfo: { mode: 'on-the-ground' } as never,
    labelingInfo: [] as never,
    legendEnabled: true,
    listMode: 'show',
  });
}

/**
 * Build point graphics from UC-3 soundings. Pure.
 * Callers MUST pass rows already filtered by `soundingsWithPosition` (or equivalent).
 */
export function bathymetryGraphics(
  soundings: BathymetrySounding[],
  surveysById: Map<number, BathymetrySurvey> = new Map(),
): Graphic[] {
  const positioned = soundingsWithPosition(soundings);
  const out: Graphic[] = [];
  for (const s of positioned) {
    const lon = s.lon as number;
    const lat = s.lat as number;
    const drawingNo = surveysById.get(s.surveyId)?.drawingNo ?? `survey-${s.surveyId}`;
    out.push(
      new Graphic({
        geometry: new Point({ longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`bathy:${s.soundingId}`),
          soundingId: s.soundingId,
          surveyId: s.surveyId,
          depthM: s.depthM,
          aboveDesign: s.aboveDesign ? 1 : 0,
          drawingNo,
        },
      }),
    );
  }
  return out;
}

/** Hint colour for UI chrome that mentions the bathymetry layer. */
export const BATHYMETRY_SHOAL_COLOR = tokens.bad;
