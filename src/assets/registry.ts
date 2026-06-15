/**
 * Sprite registry — maps domain types/status to the bundled 2D map assets.
 *
 * SVGs are imported with Vite's `?url` suffix so they ship as hashed,
 * cache-busted asset URLs in the build (and resolve correctly when the app is
 * embedded under an arbitrary path in ArcGIS Dashboards). Picture-marker
 * symbols in AISMap reference these URLs.
 */

import containerShip from './vessels/container-ship.svg?url';
import bulkCarrier from './vessels/bulk-carrier.svg?url';
import tanker from './vessels/tanker.svg?url';
import genericVessel from './vessels/generic-vessel.svg?url';
import tug from './vessels/tug.svg?url';
import pilotBoat from './vessels/pilot-boat.svg?url';
import mooringLaunch from './vessels/mooring-launch.svg?url';
import anchorGlyph from './glyphs/anchor.svg?url';
import berthGlyph from './glyphs/berth.svg?url';

import type { CraftType } from '@/types/domain';

/** Marker render size (px) per asset, sized to relative real-world scale. */
export interface SpriteDef {
  url: string;
  width: number;
  height: number;
}

export const VESSEL_SPRITES = {
  container: { url: containerShip, width: 20, height: 50 },
  bulk: { url: bulkCarrier, width: 20, height: 50 },
  tanker: { url: tanker, width: 20, height: 50 },
  generic: { url: genericVessel, width: 18, height: 45 },
} as const satisfies Record<string, SpriteDef>;

export const CRAFT_SPRITES = {
  pilot: { url: pilotBoat, width: 13, height: 27 },
  tug: { url: tug, width: 15, height: 25 },
  mooring: { url: mooringLaunch, width: 13, height: 23 },
} as const satisfies Record<CraftType, SpriteDef>;

export const GLYPHS = {
  anchor: { url: anchorGlyph, width: 18, height: 18 },
  berth: { url: berthGlyph, width: 20, height: 20 },
} as const satisfies Record<string, SpriteDef>;

/**
 * Resolve a vessel's free-text VESSEL_TYPE to a sprite. AIS vessel-type strings
 * vary widely, so we match on keywords and fall back to the generic hull.
 */
export function spriteForVesselType(vesselType: string): SpriteDef {
  const t = vesselType.toLowerCase();
  if (t.includes('container')) return VESSEL_SPRITES.container;
  if (t.includes('bulk') || t.includes('carrier')) return VESSEL_SPRITES.bulk;
  if (t.includes('tank') || t.includes('lng') || t.includes('lpg') || t.includes('crude'))
    return VESSEL_SPRITES.tanker;
  if (t.includes('tug')) return CRAFT_SPRITES.tug;
  if (t.includes('pilot')) return CRAFT_SPRITES.pilot;
  return VESSEL_SPRITES.generic;
}

export function spriteForCraft(type: CraftType): SpriteDef {
  return CRAFT_SPRITES[type];
}
