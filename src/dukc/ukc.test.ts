import { describe, it, expect } from 'vitest';
import { computeUkc, squat, tideAt, tidalWindows, ukcSensitivity, UKC_SAFETY_MARGIN_M } from './ukc';

describe('squat', () => {
  it('is zero at rest and grows with speed²', () => {
    expect(squat(0)).toBe(0);
    expect(squat(12, 0.65)).toBeGreaterThan(squat(6, 0.65));
  });
  it('is larger for fuller hulls (higher block coefficient)', () => {
    expect(squat(12, 0.8)).toBeGreaterThan(squat(12, 0.65));
  });
});

describe('computeUkc', () => {
  it('flags no-go when the water column is too shallow for the draft', () => {
    const r = computeUkc({ staticDraftM: 16, chartedDepthM: 15, tideM: 0.5, speedKt: 10, blockCoef: 0.65 });
    expect(r.status).toBe('noGo');
    expect(r.ukcM).toBeLessThan(UKC_SAFETY_MARGIN_M);
  });
  it('is go with ample tide and clearance', () => {
    const r = computeUkc({ staticDraftM: 12, chartedDepthM: 15, tideM: 2.5, speedKt: 8, blockCoef: 0.65 });
    expect(r.status).toBe('go');
    expect(r.ukcM).toBeGreaterThan(UKC_SAFETY_MARGIN_M);
  });
  it('reports available = charted + tide', () => {
    const r = computeUkc({ staticDraftM: 12, chartedDepthM: 15, tideM: 2, speedKt: 0 });
    expect(r.availableM).toBeCloseTo(17, 5);
  });
});

describe('tideAt', () => {
  it('is deterministic and bounded within a plausible envelope', () => {
    expect(tideAt(3)).toBe(tideAt(3));
    for (let h = 0; h < 48; h += 0.5) {
      const t = tideAt(h);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(6);
    }
  });
});

describe('tidalWindows', () => {
  it('produces multiple discrete windows for a tide-gated deep-draft vessel', () => {
    const w = tidalWindows({ staticDraftM: 15.5, controllingDepthM: 15, speedKt: 8, horizonH: 48 });
    expect(w.length).toBeGreaterThan(0);
    // A tide-gated vessel should NOT have one continuous window.
    expect(w.length).toBeGreaterThanOrEqual(2);
    for (const win of w) expect(win.toH).toBeGreaterThanOrEqual(win.fromH);
  });
  it('gives a shallow-draft vessel near-continuous access', () => {
    const w = tidalWindows({ staticDraftM: 9, controllingDepthM: 15, speedKt: 6, horizonH: 48 });
    const covered = w.reduce((s, win) => s + (win.toH - win.fromH), 0);
    expect(covered).toBeGreaterThan(40); // most of the 48h horizon is open
  });
});

describe('ukcSensitivity (C-2)', () => {
  it('returns nominal + 6 perturbations, worst ≤ nominal ≤ best', () => {
    const rows = ukcSensitivity({
      staticDraftM: 13.5,
      chartedDepthM: 15,
      tideM: 1.5,
      speedKt: 8,
      blockCoef: 0.65,
    });
    expect(rows).toHaveLength(7);
    const nominal = rows.find((r) => r.label === 'nominal')!.ukcM;
    const worst = rows.find((r) => r.label.startsWith('worst'))!.ukcM;
    const best = rows.find((r) => r.label.startsWith('best'))!.ukcM;
    expect(worst).toBeLessThanOrEqual(nominal);
    expect(best).toBeGreaterThanOrEqual(nominal);
  });

  it('deeper draft reduces UKC by the draft delta', () => {
    const rows = ukcSensitivity({ staticDraftM: 13, chartedDepthM: 15, tideM: 1, speedKt: 8 }, 0.2, 0.1);
    const base = rows.find((r) => r.label === 'nominal')!.ukcM;
    const deeper = rows.find((r) => r.label === 'draft +0.2 m')!.ukcM;
    expect(deeper).toBeCloseTo(base - 0.2, 2);
  });
});
