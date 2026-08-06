import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANOMALY_THRESHOLD, applyAnomalyFilter, assessRecord, describeAnomaly,
  isAnomalyRecord, isMissingValue, type QualityConfig,
} from '@/data/quality/dataQuality';
import { VESSEL_CALL_QUALITY, PILOTAGE_QUALITY } from '@/data/quality/datasets';

interface Rec { a: string; b: string; c: string; d: string; n: number }
const CFG: QualityConfig<Rec> = {
  dataset: 'Test',
  fields: [
    { key: 'a', label: 'A' }, { key: 'b', label: 'B' },
    { key: 'c', label: 'C' }, { key: 'd', label: 'D' },
  ],
};
const rec = (o: Partial<Rec> = {}): Rec => ({ a: 'x', b: 'x', c: 'x', d: 'x', n: 0, ...o });

describe('isMissingValue', () => {
  it('treats null, undefined and blank as missing', () => {
    for (const v of [null, undefined, '', '   ']) expect(isMissingValue(v)).toBe(true);
  });

  it('treats documented placeholders as missing, case-insensitively', () => {
    for (const v of ['-', '--', 'N/A', 'n/a', 'NULL', 'None', 'nil']) {
      expect(isMissingValue(v)).toBe(true);
    }
  });

  it('does NOT treat numeric zero as missing', () => {
    /* Zero moves and zero draft are real values; calling them absent would misclassify
       genuine data as an anomaly. */
    expect(isMissingValue(0)).toBe(false);
  });

  it('does not treat false or a real string as missing', () => {
    expect(isMissingValue(false)).toBe(false);
    expect(isMissingValue('CB04')).toBe(false);
  });

  it('treats an empty array as missing', () => {
    expect(isMissingValue([])).toBe(true);
  });
});

describe('threshold rule — strictly MORE than the threshold', () => {
  it('default threshold is 2', () => {
    expect(DEFAULT_ANOMALY_THRESHOLD).toBe(2);
  });

  it('two missing fields is NOT an anomaly', () => {
    expect(isAnomalyRecord(rec({ a: '', b: '' }), CFG)).toBe(false);
  });

  it('three missing fields IS an anomaly', () => {
    expect(isAnomalyRecord(rec({ a: '', b: '', c: '' }), CFG)).toBe(true);
  });

  it('a complete record is never an anomaly', () => {
    expect(isAnomalyRecord(rec(), CFG)).toBe(false);
  });

  it('the threshold is configurable per dataset', () => {
    const strict: QualityConfig<Rec> = { ...CFG, threshold: 0 };
    expect(isAnomalyRecord(rec({ a: '' }), strict)).toBe(true);
    expect(isAnomalyRecord(rec(), strict)).toBe(false);
  });

  it('a null record is an anomaly with every field reported missing', () => {
    const r = assessRecord<Rec>(null, CFG);
    expect(r.isAnomaly).toBe(true);
    expect(r.missingFields).toHaveLength(4);
  });
});

describe('assessRecord reporting', () => {
  it('names the missing fields in configured order', () => {
    expect(assessRecord(rec({ a: '', c: '-' }), CFG).missingFields).toEqual(['A', 'C']);
  });

  it('counts only CONFIGURED fields, ignoring everything else', () => {
    /* `n` is absent from the config, so an unlisted property can never trip the rule. */
    const r = assessRecord({ a: '', b: '', c: '', d: 'x', n: 0 } as Rec, CFG);
    expect(r.missingCount).toBe(3);
  });

  it('describes the anomaly with dataset, count and field names', () => {
    const text = describeAnomaly(assessRecord(rec({ a: '', b: '', c: '' }), CFG), 'Test');
    expect(text).toContain('Test');
    expect(text).toContain('3 required fields');
    expect(text).toContain('A, B, C');
  });
});

describe('applyAnomalyFilter', () => {
  const rows = [rec(), rec({ a: '', b: '', c: '' }), rec({ a: '' })];

  it('returns the list UNCHANGED when showing anomalies', () => {
    /* Identity matters: the default path must not disturb sort or pagination. */
    expect(applyAnomalyFilter(rows, CFG, true)).toBe(rows);
  });

  it('removes only anomalies when hiding them', () => {
    expect(applyAnomalyFilter(rows, CFG, false)).toHaveLength(2);
  });

  it('preserves relative order of the surviving rows', () => {
    const kept = applyAnomalyFilter(rows, CFG, false);
    expect(kept[0]).toBe(rows[0]);
    expect(kept[1]).toBe(rows[2]);
  });
});

describe('dataset registry excludes lifecycle-dependent fields', () => {
  /* The correctness guard for the whole feature: including an actual would flag every
     vessel that has simply not reached that stage yet. Measured on the live corpus,
     identity-only flags 941/1691 while adding actuals flags 1691/1691. */
  it('Vessel Call config carries no lifecycle actuals', () => {
    const keys = VESSEL_CALL_QUALITY.fields.map((f) => f.key as string);
    for (const banned of ['ata', 'atd', 'atc', 'etb', 'eta', 'berthCode', 'status', 'lifecycle']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('Pilotage config carries no movement timestamps', () => {
    const keys = PILOTAGE_QUALITY.fields.map((f) => f.key as string);
    for (const banned of ['pilotBoardedAt', 'allFastAt', 'pilotDisembarkedAt', 'lifecycle']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('every configured field has a human label', () => {
    for (const cfg of [VESSEL_CALL_QUALITY, PILOTAGE_QUALITY]) {
      for (const f of cfg.fields) expect(f.label.length).toBeGreaterThan(0);
    }
  });
});
