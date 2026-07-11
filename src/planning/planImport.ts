/**
 * Berthing-plan import parser (spec IU-2, §5.3, §5.8 file-upload hardening).
 *
 * Accepts the CSV that JNPA realistically produces (and XLSX exported to CSV) and
 * maps rows onto `BerthingPlanEntry`. Deliberately defensive:
 *  - mixed date formats (ISO, DD-MM-YYYY, DD/MM/YYYY HH:mm, epoch ms, Excel
 *    serial floats) are all parsed, with a per-row error when a cell can't be;
 *  - CSV formula-injection (a cell starting with = + - @) is neutralised so the
 *    file can't attack Excel when re-opened (OWASP CSV injection);
 *  - a size cap and a row cap guard against upload abuse;
 *  - every problem row is reported with a line number and a remedy, never
 *    silently dropped.
 *
 * Pure and dependency-free (no SheetJS): real deployment can add an XLSX reader,
 * but the contract and validation live here.
 */

import type { BerthingPlanEntry, PlanStatus } from '@/types/domain';

/** Max upload size (bytes) and row count — upload-abuse guard. */
export const MAX_IMPORT_BYTES = 2_000_000; // 2 MB
export const MAX_IMPORT_ROWS = 5000;

/** Excel's day-0 is 1899-12-30 (the well-known 1900 leap bug offset). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export interface ImportRowError {
  line: number; // 1-based, including header
  field: string;
  message: string;
}

export interface ImportResult {
  entries: BerthingPlanEntry[];
  errors: ImportRowError[];
  /** Rows read (excluding header). */
  rowCount: number;
}

/**
 * Neutralise a CSV formula-injection payload: prefix a leading =,+,-,@ (or tab/CR)
 * with a single quote so spreadsheet apps treat it as text. Returns the safe
 * string. Applied to every free-text field we keep.
 */
export function sanitizeCell(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) return s;
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

/** Split a CSV line respecting simple double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a date cell across the formats JNPA files realistically contain.
 * Returns epoch ms, or null if unparseable. Interprets bare dates as IST.
 */
export function parsePlanDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // Pure number: epoch ms (>= ~10^12) or an Excel serial day (< 100000).
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1_000_000_000_000) return n; // already epoch ms
    if (n > 20_000 && n < 100_000) return EXCEL_EPOCH_MS + n * DAY_MS; // Excel serial
    // Small integers are ambiguous — treat as unparseable rather than guess.
    return null;
  }

  // ISO 8601 (let the engine handle offset/no-offset).
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(s)) {
    const ms = Date.parse(s.length <= 10 ? `${s}T00:00:00+05:30` : s.replace(' ', 'T'));
    return Number.isNaN(ms) ? null : ms;
  }

  // DD-MM-YYYY or DD/MM/YYYY, optional HH:mm — the Indian convention.
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) {
    const [, dd, mm, yyyy, hh = '0', min = '0'] = m;
    const d = Number(dd);
    const mo = Number(mm);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    // Construct as IST (UTC+5:30).
    const utc = Date.UTC(Number(yyyy), mo - 1, d, Number(hh), Number(min)) - 5.5 * DAY_MS / 24;
    return utc;
  }

  return null;
}

const REQUIRED = ['BERTH_ID', 'MMSI', 'VESSEL_NAME', 'PLANNED_START', 'PLANNED_END'];

/**
 * Parse a plan CSV. Header row must contain (case-insensitive) at least the
 * REQUIRED columns; optional PLAN_ID / STATUS are honoured. Never throws.
 */
export function parsePlanCsv(text: string): ImportResult {
  const errors: ImportRowError[] = [];
  const entries: BerthingPlanEntry[] = [];

  if (text.length > MAX_IMPORT_BYTES) {
    return {
      entries,
      errors: [{ line: 0, field: 'file', message: `File exceeds ${MAX_IMPORT_BYTES / 1e6} MB cap.` }],
      rowCount: 0,
    };
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { entries, errors: [{ line: 0, field: 'file', message: 'Empty file.' }], rowCount: 0 };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const idx = (name: string) => header.indexOf(name);
  const missing = REQUIRED.filter((r) => idx(r) < 0);
  if (missing.length) {
    return {
      entries,
      errors: [{ line: 1, field: 'header', message: `Missing required columns: ${missing.join(', ')}.` }],
      rowCount: 0,
    };
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_IMPORT_ROWS) {
    return {
      entries,
      errors: [{ line: 0, field: 'file', message: `Row count exceeds ${MAX_IMPORT_ROWS} cap.` }],
      rowCount: dataLines.length,
    };
  }

  dataLines.forEach((line, i) => {
    const lineNo = i + 2; // 1-based incl header
    const cells = splitCsvLine(line);
    const get = (name: string) => (idx(name) >= 0 ? (cells[idx(name)] ?? '').trim() : '');

    const berthId = sanitizeCell(get('BERTH_ID'));
    const mmsi = sanitizeCell(get('MMSI'));
    const name = sanitizeCell(get('VESSEL_NAME'));
    const start = parsePlanDate(get('PLANNED_START'));
    const end = parsePlanDate(get('PLANNED_END'));

    let ok = true;
    if (!berthId) {
      errors.push({ line: lineNo, field: 'BERTH_ID', message: 'Missing berth id.' });
      ok = false;
    }
    if (!mmsi) {
      errors.push({ line: lineNo, field: 'MMSI', message: 'Missing MMSI.' });
      ok = false;
    }
    if (start === null) {
      errors.push({ line: lineNo, field: 'PLANNED_START', message: `Unparseable date "${get('PLANNED_START')}". Use DD-MM-YYYY HH:mm or ISO.` });
      ok = false;
    }
    if (end === null) {
      errors.push({ line: lineNo, field: 'PLANNED_END', message: `Unparseable date "${get('PLANNED_END')}". Use DD-MM-YYYY HH:mm or ISO.` });
      ok = false;
    }
    if (ok && start !== null && end !== null && end <= start) {
      errors.push({ line: lineNo, field: 'PLANNED_END', message: 'End must be after start.' });
      ok = false;
    }
    if (!ok) return;

    const statusRaw = get('STATUS').toLowerCase();
    const status: PlanStatus = (['scheduled', 'active', 'completed', 'cancelled'] as PlanStatus[]).includes(
      statusRaw as PlanStatus
    )
      ? (statusRaw as PlanStatus)
      : 'scheduled';

    entries.push({
      PLAN_ID: sanitizeCell(get('PLAN_ID')) || `IMP-${lineNo}`,
      BERTH_ID: berthId,
      MMSI: mmsi,
      VESSEL_NAME: name || `MMSI ${mmsi}`,
      PLANNED_START: start!,
      PLANNED_END: end!,
      ACTUAL_START: null,
      ACTUAL_END: null,
      STATUS: status,
    });
  });

  return { entries, errors, rowCount: dataLines.length };
}
