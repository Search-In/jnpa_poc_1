import { describe, it, expect } from 'vitest';
import {
  parsePlanCsv,
  parsePlanDate,
  sanitizeCell,
  splitCsvLine,
  MAX_IMPORT_ROWS,
} from './planImport';

describe('sanitizeCell — CSV formula-injection neutralisation', () => {
  it('prefixes dangerous leading chars with a quote', () => {
    expect(sanitizeCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(sanitizeCell('+1+2')).toBe("'+1+2");
    expect(sanitizeCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('leaves normal text untouched', () => {
    expect(sanitizeCell('MSC ANNA')).toBe('MSC ANNA');
    expect(sanitizeCell('  B1  ')).toBe('B1');
  });
});

describe('splitCsvLine', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('"a""b",c')).toEqual(['a"b', 'c']);
  });
});

describe('parsePlanDate — mixed formats', () => {
  it('parses ISO with and without time', () => {
    expect(parsePlanDate('2026-07-11T06:30')).toBe(Date.parse('2026-07-11T06:30'));
    expect(parsePlanDate('2026-07-11')).toBe(Date.parse('2026-07-11T00:00:00+05:30'));
  });
  it('parses DD-MM-YYYY and DD/MM/YYYY HH:mm as IST', () => {
    const a = parsePlanDate('11-07-2026 06:30');
    const b = parsePlanDate('11/07/2026 06:30');
    expect(a).toBe(b);
    // 06:30 IST == 01:00 UTC
    expect(new Date(a!).toISOString()).toBe('2026-07-11T01:00:00.000Z');
  });
  it('parses epoch ms and Excel serial floats', () => {
    expect(parsePlanDate('1700000000000')).toBe(1_700_000_000_000);
    // Excel serial 45849 ≈ 2025-07-11
    const ms = parsePlanDate('45849');
    expect(ms).not.toBeNull();
    expect(new Date(ms!).getUTCFullYear()).toBe(2025);
  });
  it('rejects garbage and ambiguous small integers', () => {
    expect(parsePlanDate('not-a-date')).toBeNull();
    expect(parsePlanDate('42')).toBeNull();
    expect(parsePlanDate('32-01-2026')).toBeNull(); // day 32
  });
});

describe('parsePlanCsv', () => {
  const header = 'BERTH_ID,MMSI,VESSEL_NAME,PLANNED_START,PLANNED_END,STATUS';

  it('imports a clean file', () => {
    const csv = [
      header,
      'B1,419000001,MSC ALPHA,11-07-2026 06:00,11-07-2026 18:00,scheduled',
      'B2,419000002,MSC BRAVO,2026-07-12T02:00,2026-07-12T14:00,active',
    ].join('\n');
    const r = parsePlanCsv(csv);
    expect(r.errors).toHaveLength(0);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].BERTH_ID).toBe('B1');
    expect(r.entries[1].STATUS).toBe('active');
  });

  it('reports per-row errors with line numbers and does not drop silently', () => {
    const csv = [
      header,
      'B1,419000001,GOOD,11-07-2026 06:00,11-07-2026 18:00,scheduled',
      'B2,,NO MMSI,11-07-2026 06:00,11-07-2026 18:00,scheduled',
      'B3,419000003,BAD DATE,frobnicate,11-07-2026 18:00,scheduled',
      'B4,419000004,END BEFORE START,11-07-2026 18:00,11-07-2026 06:00,scheduled',
    ].join('\n');
    const r = parsePlanCsv(csv);
    expect(r.entries).toHaveLength(1); // only the good row
    expect(r.errors.find((e) => e.line === 3 && e.field === 'MMSI')).toBeTruthy();
    expect(r.errors.find((e) => e.line === 4 && e.field === 'PLANNED_START')).toBeTruthy();
    expect(r.errors.find((e) => e.line === 5 && e.field === 'PLANNED_END')).toBeTruthy();
  });

  it('neutralises formula injection in imported names', () => {
    const csv = [header, 'B1,419000001,=HYPERLINK(1),11-07-2026 06:00,11-07-2026 18:00,scheduled'].join(
      '\n'
    );
    const r = parsePlanCsv(csv);
    expect(r.entries[0].VESSEL_NAME.startsWith("'=")).toBe(true);
  });

  it('rejects a file missing required columns', () => {
    const r = parsePlanCsv('BERTH_ID,MMSI\nB1,419000001');
    expect(r.entries).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/Missing required columns/);
  });

  it('caps oversized row counts', () => {
    const rows = Array.from(
      { length: MAX_IMPORT_ROWS + 1 },
      (_, i) => `B1,41900${i},V${i},11-07-2026 06:00,11-07-2026 18:00,scheduled`
    );
    const r = parsePlanCsv([header, ...rows].join('\n'));
    expect(r.errors[0].message).toMatch(/Row count exceeds/);
  });

  it('defaults an unknown status to scheduled', () => {
    const csv = [header, 'B1,419000001,V,11-07-2026 06:00,11-07-2026 18:00,bogus'].join('\n');
    expect(parsePlanCsv(csv).entries[0].STATUS).toBe('scheduled');
  });
});
