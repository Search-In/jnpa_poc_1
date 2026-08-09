/**
 * Operational phrasing — a 1:1 relabelling of engine values, nothing more.
 *
 * The vocabularies asserted here are lifted from services/marine/state_engine.py
 * (derive_state) and parsers/pcs_common.py. If the engine gains a state, the fall-through
 * test below is what stops it disappearing from the UI.
 */

import { describe, it, expect } from 'vitest';
import {
  arrivalLabel, berthLabel, craftLabel, departureLabel, phaseReason, pilotLabel, stageLabel,
} from './craftDemandLabels';

describe('operational phrasing covers the engine vocabulary', () => {
  it.each([
    ['Departed', 'Departed'],
    ['Sailing', 'Sailing from Berth'],
    ['At Berth', 'Currently Berthed'],
    ['Pilot Boarded', 'Pilot Onboard'],
    ['Anchored', 'At Anchorage'],
    ['Berth Allotted', 'Berth Allotted'],
    ['Berth Planned', 'Berth Applied For'],
    ['VCN Allotted', 'Call Number Issued'],
    ['Planned', 'Voyage Registered'],
  ])('stage %s → %s', (v, want) => expect(stageLabel(v)).toBe(want));

  it.each([['Completed', 'Arrival Completed'], ['Anchored', 'Waiting at Anchorage'],
           ['Pending', 'Arrival Pending']])(
    'arrival %s → %s', (v, want) => expect(arrivalLabel(v)).toBe(want));

  it.each([['Completed', 'Pilot Operation Completed'], ['Active', 'Pilot Onboard'],
           ['Pending', 'Pilot Not Yet Boarded']])(
    'pilot %s → %s', (v, want) => expect(pilotLabel(v)).toBe(want));

  it.each([['Released', 'Berth Released'], ['Occupied', 'Currently Berthed'],
           ['Allotted', 'Berth Allotted'], ['Pending', 'No Berth Yet']])(
    'berth %s → %s', (v, want) => expect(berthLabel(v)).toBe(want));

  it.each([['Completed', 'Departed'], ['Sailing', 'Sailing'],
           ['Pending', 'Departure Pending']])(
    'departure %s → %s', (v, want) => expect(departureLabel(v)).toBe(want));

  it('phase is phrased as the REASON the row appears', () => {
    expect(phaseReason('Alongside')).toMatch(/berthed and not yet departed/i);
    expect(phaseReason('Inbound')).toMatch(/pilot aboard/i);
    expect(phaseReason('Outbound')).toMatch(/sailed/i);
  });

  // 'Busy' is a property of the CALL, never of a craft. The wording must not imply that
  // a specific tug or launch has been engaged — nothing in the schema records that.
  it('craft state reads as a requirement, not an assignment', () => {
    expect(craftLabel('Busy')).toBe('Requires marine support');
    expect(craftLabel('Idle')).toBe('No support required');
    for (const banned of ['Tug', 'Launch', 'Assigned', 'Engaged']) {
      expect(craftLabel('Busy')).not.toContain(banned);
    }
  });
});

describe('nothing is invented and nothing is hidden', () => {
  // A new engine state must surface as its raw word, not vanish — a blank cell would
  // read as "no data" when the truth is "the UI has no phrase for this yet".
  it('falls through verbatim for an unmapped value', () => {
    for (const fn of [stageLabel, arrivalLabel, pilotLabel, berthLabel,
                      departureLabel, phaseReason, craftLabel]) {
      expect(fn('Quarantined')).toBe('Quarantined');
    }
  });

  it('maps an empty value to empty, so the caller can omit the field', () => {
    for (const fn of [stageLabel, arrivalLabel, pilotLabel, berthLabel,
                      departureLabel, phaseReason]) {
      expect(fn('')).toBe('');
    }
  });

  it('is a pure relabelling — one input, one output, no combining', () => {
    // Same input always yields the same phrase regardless of call order/context.
    expect(stageLabel('At Berth')).toBe(stageLabel('At Berth'));
    // Distinct engine values never collapse into one phrase within a vocabulary.
    const arrivals = ['Completed', 'Anchored', 'Pending'].map(arrivalLabel);
    expect(new Set(arrivals).size).toBe(3);
  });
});
