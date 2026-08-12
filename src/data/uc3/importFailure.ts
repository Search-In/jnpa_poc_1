/**
 * Shared “why did this import fail?” copy for UC-3 upload panels.
 *
 * Gateway validate/import often returns HTTP 200 with `status: REJECTED|FAILED|
 * PARTIAL` — so panels must explain the outcome from the body, not only from
 * thrown transport errors.
 */

export interface ImportParseErrorLike {
  row_number?: number | null;
  column_name?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
  /** Some ledgers use error_message instead of error_detail. */
  error_message?: string | null;
}

export interface ImportFailureInput {
  status: string;
  errors?: ImportParseErrorLike[] | null;
  duplicateFile?: boolean | null;
  /** Free-text ledger / service detail when present. */
  detail?: string | null;
  /** Optional counts for richer copy. */
  invalid?: number | null;
  failed?: number | null;
}

function formatOne(e: ImportParseErrorLike): string {
  const where =
    e.row_number != null
      ? `Row ${e.row_number}`
      : e.column_name
        ? String(e.column_name)
        : 'Row';
  const what = (e.error_detail || e.error_message || e.error_code || 'unknown fault').trim();
  return e.column_name && e.row_number != null
    ? `${where} · ${e.column_name}: ${what}`
    : `${where}: ${what}`;
}

/**
 * Returns null when the status is a success path. Otherwise a single operator
 * sentence (plus first few row faults) explaining why nothing / only some rows landed.
 */
export function importFailureReason(input: ImportFailureInput): string | null {
  const status = (input.status || '').trim().toUpperCase();
  if (!status) return null;
  if (status === 'SUCCESS' || status === 'VALIDATED' || status === 'IMPORTED') return null;

  if (input.duplicateFile || status === 'SKIPPED_DUPLICATE') {
    return (
      'Identical file was already imported (byte-for-byte duplicate). ' +
      'Use Override Import to re-process, or switch the header to DEMO to see previous imports.'
    );
  }

  const parts: string[] = [];
  if (status === 'REJECTED') {
    parts.push('Import rejected — nothing was written to the database.');
  } else if (status === 'FAILED') {
    parts.push('Import failed while saving — check format, auth role, and gateway logs.');
  } else if (status === 'PARTIAL') {
    parts.push('Partial import — some rows saved, some failed.');
  } else {
    parts.push(`Import ended with status ${input.status}.`);
  }

  if (input.invalid != null && input.invalid > 0) {
    parts.push(`${input.invalid} invalid row(s).`);
  }
  if (input.failed != null && input.failed > 0) {
    parts.push(`${input.failed} failed row(s).`);
  }

  const detail = (input.detail || '').trim();
  if (detail) parts.push(detail);

  const errors = input.errors ?? [];
  if (errors.length > 0) {
    const head = errors.slice(0, 3).map(formatOne).join(' · ');
    parts.push(
      errors.length > 3 ? `Examples: ${head} …(+${errors.length - 3} more)` : `Detail: ${head}`,
    );
  } else if (!detail) {
    parts.push(
      'No row-level detail was returned — run Validate first, or open Upload history for the ledger message.',
    );
  }

  return parts.join(' ');
}
