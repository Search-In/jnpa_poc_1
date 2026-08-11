import { describe, it, expect } from 'vitest';
import { importFailureReason } from './importFailure';

describe('importFailureReason', () => {
  it('returns null for success statuses', () => {
    expect(importFailureReason({ status: 'SUCCESS' })).toBeNull();
    expect(importFailureReason({ status: 'VALIDATED' })).toBeNull();
    expect(importFailureReason({ status: 'IMPORTED' })).toBeNull();
  });

  it('explains duplicates without treating them as hard failures', () => {
    const msg = importFailureReason({ status: 'SKIPPED_DUPLICATE', duplicateFile: true });
    expect(msg).toMatch(/already imported/i);
    expect(msg).toMatch(/DEMO/i);
  });

  it('explains REJECTED with row-level detail', () => {
    const msg = importFailureReason({
      status: 'REJECTED',
      errors: [
        { row_number: 2, column_name: 'ATA', error_detail: 'not a timestamp' },
        { row_number: 3, column_name: 'VCN', error_code: 'required' },
      ],
    });
    expect(msg).toMatch(/nothing was written/i);
    expect(msg).toMatch(/Row 2/);
    expect(msg).toMatch(/not a timestamp/);
  });

  it('falls back when there are no errors', () => {
    const msg = importFailureReason({ status: 'FAILED' });
    expect(msg).toMatch(/Validate first|Upload history/i);
  });
});
