/**
 * Business-field registry — which fields each imported dataset must carry.
 *
 * ONE PLACE. Every module reads its rule from here, so "what makes a record incomplete"
 * is answered identically on every screen and a rule change is a single edit.
 *
 * SELECTION RULE, applied to every entry below
 * -------------------------------------------
 * Include a field ONLY IF the source document should always carry it — identity and
 * provenance. Exclude:
 *
 *   * lifecycle actuals (ATA / ATD / ATC / berth once allotted, boarding times) — a blank
 *     one is a STAGE, not a defect, and including them flags every normal vessel;
 *   * derived or computed values (lifecycle blocks, projections, states);
 *   * internal keys (row ids, import file ids) and optional UI decoration.
 *
 * Measured against the live corpus, the vessel-call set below flags 941 of 1691 records;
 * adding the lifecycle actuals flags 1691 of 1691. That gap is why the rule is a curated
 * list rather than "count every empty property".
 */

import type { QualityConfig } from './dataQuality';
import type {
  BathymetrySurvey, BerthingReport, Pilotage, PortCraft, VesselCall, VesselMaster,
} from '@/types/domain';

/**
 * Vessel Calls — the PCS call spine.
 *
 * VCN and VIA are both listed although a pre-VCN call legitimately has no VCN: a record
 * missing BOTH keys plus its vessel name has no usable identity at all, which is exactly
 * the incompleteness this rule is meant to surface. Two missing on their own stay under
 * the threshold.
 */
export const VESSEL_CALL_QUALITY: QualityConfig<VesselCall> = {
  dataset: 'Vessel Call',
  fields: [
    { key: 'vcn', label: 'VCN' },
    { key: 'viaNo', label: 'VIA' },
    { key: 'imoNo', label: 'IMO' },
    { key: 'vesselName', label: 'Vessel Name' },
    { key: 'voyageNo', label: 'Voyage' },
    { key: 'terminalCode', label: 'Terminal' },
  ],
};

/**
 * Pilotage — imported pilot-card and pilot-memo movements.
 *
 * `pilotCode` is included but boarding/disembark times are NOT: a movement recorded before
 * the pilot stepped aboard is in progress, not defective.
 */
export const PILOTAGE_QUALITY: QualityConfig<Pilotage> = {
  dataset: 'Pilotage',
  fields: [
    { key: 'viaNo', label: 'VIA' },
    { key: 'imoNo', label: 'IMO' },
    { key: 'vesselName', label: 'Vessel Name' },
    { key: 'movementType', label: 'Movement' },
    { key: 'pilotCode', label: 'Pilot Code' },
    { key: 'vesselCondition', label: 'Condition' },
  ],
};

/** Berthing reports — terminal-issued arrival/departure records. */
export const BERTHING_QUALITY: QualityConfig<BerthingReport> = {
  dataset: 'Berthing Report',
  fields: [
    { key: 'vesselName', label: 'Vessel Name' },
    { key: 'terminal', label: 'Terminal' },
    { key: 'voyageNumber', label: 'Voyage' },
    { key: 'imoNumber', label: 'IMO' },
    { key: 'shippingLine', label: 'Shipping Line' },
    { key: 'berthNumber', label: 'Berth' },
  ],
};

/** Vessel master register — VESPRO particulars. */
export const VESSEL_MASTER_QUALITY: QualityConfig<VesselMaster> = {
  dataset: 'Vessel',
  fields: [
    { key: 'imoNo', label: 'IMO' },
    { key: 'vesselName', label: 'Name' },
    { key: 'callSign', label: 'Call Sign' },
    { key: 'flag', label: 'Flag' },
    { key: 'vesselType', label: 'Type' },
  ],
};

/** Port-craft fleet register — Details_of_Port_Crafts.pdf particulars. */
export const PORT_CRAFT_QUALITY: QualityConfig<PortCraft> = {
  dataset: 'Port Craft',
  fields: [
    { key: 'name', label: 'Name' },
    { key: 'craftType', label: 'Type' },
    { key: 'ownedOrHired', label: 'Owned/Hired' },
    { key: 'ownerName', label: 'Owner' },
    { key: 'yearBuilt', label: 'Year Built' },
  ],
};

/**
 * Bathymetry surveys — chart headers.
 *
 * `soundingCount` and `designDepthM` are deliberately absent: the first is DERIVED from
 * the child rows, and a chart legitimately carries no design depth. Both would have made
 * a complete survey look defective.
 */
export const BATHYMETRY_QUALITY: QualityConfig<BathymetrySurvey> = {
  dataset: 'Bathymetry Survey',
  fields: [
    { key: 'drawingNo', label: 'Drawing No' },
    { key: 'sectionLabel', label: 'Section' },
    { key: 'surveyVessel', label: 'Survey Vessel' },
    { key: 'surveyStart', label: 'Survey Start' },
    { key: 'surveyEnd', label: 'Survey End' },
  ],
};
