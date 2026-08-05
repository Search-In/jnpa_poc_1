import { describe, it, expect } from 'vitest';
import type { ModelBlock } from '@/data/ml/types';
import {
  MODEL_VIEWS,
  formatValue,
  gridFields,
  humaniseKey,
  orderedBlocks,
  statusTone,
} from './modelViews';

describe('statusTone', () => {
  it('reads a channel verdict the way a pilot does', () => {
    expect(statusTone('SAFE')).toBe('good');
    expect(statusTone('MARGINAL')).toBe('warn');
    expect(statusTone('NO GO')).toBe('bad');
  });

  it('accepts the hyphenated and unspaced spellings of NO GO', () => {
    expect(statusTone('NO-GO')).toBe('bad');
    expect(statusTone('NOGO')).toBe('bad');
  });

  it('maps confidence and alert bands', () => {
    expect(statusTone('HIGH')).toBe('good');
    expect(statusTone('MEDIUM')).toBe('warn');
    expect(statusTone('LOW')).toBe('bad');
    expect(statusTone('NORMAL')).toBe('good');
    expect(statusTone('ADVISORY')).toBe('warn');
    expect(statusTone('CRITICAL')).toBe('bad');
  });

  it('is neutral for text it does not know — never optimistically green', () => {
    expect(statusTone('PENDING REVIEW')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });

  it('treats a boolean verdict as pass/fail', () => {
    expect(statusTone(true)).toBe('good');
    expect(statusTone(false)).toBe('bad');
  });
});

describe('formatValue', () => {
  it('renders null as an em dash, never as zero', () => {
    // "no value" and "zero clearance" are different answers.
    expect(formatValue(null)).toBe('—');
    expect(formatValue(0)).toBe('0');
  });

  it('renders an empty string as "not stated", not as a blank cell', () => {
    // M5 sends requested_berth: '' when no berth was asked for. Rendered raw it
    // looked like the UI had failed rather than the value being absent.
    expect(formatValue('')).toBe('—');
    expect(formatValue('   ')).toBe('—');
  });

  it('keeps at most two decimals and drops trailing zeros', () => {
    expect(formatValue(0.9500001)).toBe('0.95');
    expect(formatValue(43.5)).toBe('43.5');
    expect(formatValue(21)).toBe('21');
  });

  it('renders a non-finite number as unknown rather than Infinity', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('joins lists and flattens objects', () => {
    expect(formatValue(['PL-01', 'TG-05'])).toBe('PL-01, TG-05');
    expect(formatValue([])).toBe('—');
    expect(formatValue({ factor: 'parcel_teu', hours: 14.4 })).toBe('Factor: parcel_teu · Hours: 14.4');
  });

  it('passes a model string through — M1 may answer in words', () => {
    // max_safe_speed_kn is a number OR 'no speed makes it SAFE'.
    expect(formatValue('no speed makes it SAFE')).toBe('no speed makes it SAFE');
  });

  it('renders booleans as words', () => {
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(false)).toBe('No');
  });
});

describe('humaniseKey', () => {
  it('turns a wire key into a readable label', () => {
    expect(humaniseKey('net_ukc_m')).toBe('Net ukc m');
    expect(humaniseKey('m5_berth_plan')).toBe('M5 berth plan');
  });
});

describe('orderedBlocks', () => {
  const m1: ModelBlock = { status: 'SAFE', net_ukc_m: 0.95 };
  const m3: ModelBlock = { tat_hours: 43.5 };

  it('returns the known models in spec order, whichever order they arrived in', () => {
    const out = orderedBlocks({ m3_turnaround_time: m3, m1_under_keel_clearance: m1 });
    expect(out.map((o) => o.view.id)).toEqual(['m1_under_keel_clearance', 'm3_turnaround_time']);
  });

  it('omits a model that did not run', () => {
    expect(orderedBlocks({ m1_under_keel_clearance: m1 })).toHaveLength(1);
  });

  it('still renders a block it has never seen, rather than dropping it', () => {
    // A model gaining a block is exactly the thing worth looking at; hiding it
    // behind a hard-coded list would make the panel quietly wrong.
    const out = orderedBlocks({ m9_new_model: { value: 1 } });
    expect(out).toHaveLength(1);
    expect(out[0].view.title).toBe('M9 new model');
  });

  it('covers all eight models in MODEL_VIEWS', () => {
    expect(MODEL_VIEWS.map((v) => v.id)).toEqual([
      'm1_under_keel_clearance',
      'm2_tidal_window',
      'm3_turnaround_time',
      'm4_eta_confidence',
      'm5_berth_plan',
      'm6_jit_arrival',
      'm7_port_craft',
      'm8_risk_chain',
    ]);
  });
});

describe('gridFields', () => {
  it('skips the fields the card renders itself', () => {
    const block: ModelBlock = {
      status: 'SAFE',
      net_ukc_m: 0.95,
      squat_m: 0.65,
      recommendation: 'hold for tide',
    };
    const view = MODEL_VIEWS[0];
    expect(gridFields(block, view).map(([k]) => k)).toEqual(['squat_m']);
  });

  it('keeps the order the service sent for everything else', () => {
    const block: ModelBlock = { b: 1, a: 2 };
    expect(gridFields(block, { id: 'x', title: 'X' }).map(([k]) => k)).toEqual(['b', 'a']);
  });
});
