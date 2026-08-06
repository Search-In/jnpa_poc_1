import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MARINE_UPLOAD_PATH,
  MARINE_UPLOADS_PATH,
  MARINE_VALIDATE_PATH,
  UPLOAD_FIELD,
  buildUploadForm,
  fetchMarineUpload,
  fetchMarineUploads,
  fetchMarineUploadsPage,
  importMarineCsv,
  overrideImportMarineCsv,
  mapUploadError,
  mapUploadFile,
  marineUploadsQuery,
  parseUploadDetail,
  parseUploadsPage,
  validateMarineCsv,
  type MarineUploadErrorWire,
  type MarineUploadFileWire,
} from './marineUpload';
import { clearAuthToken } from './token';

const LEDGER: MarineUploadFileWire = {
  id: 1,
  filename: 'calls.csv',
  file_hash: 'a'.repeat(64),
  physical_format: 'CSV',
  uploaded_by: 'dev',
  status: 'SUCCESS',
  total_rows: 3,
  success_rows: 3,
  failed_rows: 0,
  duplicate_rows: 0,
  source: 'UPLOAD',
  error_detail: null,
  created_at: '2026-06-05T10:00:00Z',
  updated_at: '2026-06-05T10:00:01Z',
};

const uploadsPage = (items: MarineUploadFileWire[], total = items.length) => ({
  items,
  total,
  limit: 50,
  offset: 0,
  count: items.length,
});

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const loginBody = {
  access_token: 'T1',
  token_type: 'bearer',
  role: 'DTCCC_ADMIN',
  auth_enabled: true,
};

/** A CSV File, as the browser file picker would hand it over. */
function csvFile(name = 'calls.csv'): File {
  return new File(['VCN\nINNSA1BM0R3119\n'], name, { type: 'text/csv' });
}

beforeEach(() => {
  clearAuthToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('buildUploadForm', () => {
  it('puts the file under the field name the gateway expects', () => {
    const fd = buildUploadForm(csvFile());
    expect(fd.get(UPLOAD_FIELD)).toBeInstanceOf(File);
    expect((fd.get(UPLOAD_FIELD) as File).name).toBe('calls.csv');
  });

  it('sends NO selector — marine upload is not terminal/facility scoped', () => {
    const keys = [...buildUploadForm(csvFile()).keys()];
    expect(keys).toEqual([UPLOAD_FIELD]);
  });
});

describe('mapUploadFile (wire → domain)', () => {
  it('maps a full ledger row', () => {
    const f = mapUploadFile(LEDGER)!;
    expect(f).toMatchObject({
      id: 1,
      filename: 'calls.csv',
      status: 'SUCCESS',
      totalRows: 3,
      successRows: 3,
      source: 'UPLOAD',
    });
    expect(f.createdAt).toBe(Date.parse('2026-06-05T10:00:00Z'));
  });

  it('drops a row with no id', () => {
    expect(mapUploadFile({ ...LEDGER, id: null })).toBeNull();
  });

  it('turns a null error_detail into an empty string', () => {
    expect(mapUploadFile(LEDGER)!.errorDetail).toBe('');
  });

  it('defaults missing counts to 0', () => {
    const f = mapUploadFile({ ...LEDGER, failed_rows: null, duplicate_rows: null })!;
    expect(f.failedRows).toBe(0);
    expect(f.duplicateRows).toBe(0);
  });
});

describe('mapUploadError', () => {
  const ERR: MarineUploadErrorWire = {
    id: 7,
    row_number: 4,
    error_message: 'VCN: VCN is empty',
    raw_data: null,
    created_at: '2026-06-05T10:00:00Z',
  };

  it('maps a row error', () => {
    expect(mapUploadError(ERR)).toMatchObject({
      id: 7,
      rowNumber: 4,
      errorMessage: 'VCN: VCN is empty',
    });
  });

  it('keeps rowNumber NULL for a file-level error — 0 would read as "row 0"', () => {
    expect(mapUploadError({ ...ERR, row_number: null })!.rowNumber).toBeNull();
  });

  it('drops an error with no id', () => {
    expect(mapUploadError({ ...ERR, id: null })).toBeNull();
  });
});

describe('parseUploadsPage / parseUploadDetail', () => {
  it('preserves the server ordering (newest first)', () => {
    const rows = parseUploadsPage(uploadsPage([LEDGER, { ...LEDGER, id: 2 }]));
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns [] for a malformed payload', () => {
    expect(parseUploadsPage(null)).toEqual([]);
    expect(parseUploadsPage({ items: 'nope' })).toEqual([]);
  });

  it('splits the detail envelope into file + errors', () => {
    const { file, errors } = parseUploadDetail({
      ...LEDGER,
      errors: [
        {
          id: 7,
          row_number: 2,
          error_message: 'bad ts',
          raw_data: '31/31/2026',
          created_at: null,
        },
      ],
    });
    expect(file?.id).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].rawData).toBe('31/31/2026');
  });

  it('tolerates a detail row with no errors array', () => {
    expect(parseUploadDetail(LEDGER).errors).toEqual([]);
    expect(parseUploadDetail(null)).toEqual({ file: null, errors: [] });
  });
});

describe('marineUploadsQuery', () => {
  it('emits only the page window when unfiltered', () => {
    expect(marineUploadsQuery()).toBe(`${MARINE_UPLOADS_PATH}?limit=50&offset=0`);
  });

  it('emits status and source when set', () => {
    const q = marineUploadsQuery({ status: 'PARTIAL', source: 'UPLOAD' }, 10, 20);
    expect(q).toContain('status=PARTIAL');
    expect(q).toContain('source=UPLOAD');
    expect(q).toContain('limit=10');
    expect(q).toContain('offset=20');
  });
});

describe('validateMarineCsv / importMarineCsv (multipart transport)', () => {
  it('POSTs multipart to /marine/validate WITHOUT a content-type header', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login')
        ? jsonResponse(loginBody)
        : jsonResponse({ status: 'VALIDATED', valid: true, summary: {}, preview: [], errors: [], warnings: [] }),
    );
    vi.stubGlobal('fetch', spy);

    const res = await validateMarineCsv(csvFile());
    expect(res.status).toBe('VALIDATED');

    const [url, init] = spy.mock.calls[1];
    expect(url).toBe(`/api${MARINE_VALIDATE_PATH}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    // The browser must set content-type itself so the multipart boundary matches.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer T1');
    expect(headers['content-type']).toBeUndefined();
  });

  it('POSTs to /marine/upload and surfaces the import outcome', async () => {
    const spy = vi.fn((url: string) =>
      String(url).endsWith('/auth/login')
        ? jsonResponse(loginBody)
        : jsonResponse({
            file_id: 1,
            status: 'SUCCESS',
            imported: 3,
            updated: 0,
            skipped: 0,
            invalid: 0,
            duplicate_file: false,
            summary: {},
          }),
    );
    vi.stubGlobal('fetch', spy);

    const res = await importMarineCsv(csvFile());
    expect(res).toMatchObject({ file_id: 1, status: 'SUCCESS', imported: 3 });
    expect(spy.mock.calls[1][0]).toBe(`/api${MARINE_UPLOAD_PATH}`);
  });

  it('resolves (does NOT reject) when the backend rejects the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({
              file_id: 2,
              status: 'REJECTED',
              imported: 0,
              updated: 0,
              skipped: 0,
              invalid: 0,
              duplicate_file: false,
              summary: {},
              errors: [{ row_number: null, column_name: 'VCN', error_code: 'missing_column', error_detail: 'VCN column not found', raw_value: null }],
            }),
      ),
    );
    // A rejected CSV is HTTP 200 with status REJECTED — callers must check
    // `status`, not merely the absence of a thrown error.
    const res = await importMarineCsv(csvFile());
    expect(res.status).toBe('REJECTED');
    expect(res.errors?.[0].error_code).toBe('missing_column');
  });

  it('reports a duplicate re-upload as SKIPPED_DUPLICATE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({
              file_id: 1,
              status: 'SKIPPED_DUPLICATE',
              imported: 0,
              updated: 0,
              skipped: 0,
              invalid: 0,
              duplicate_file: true,
              summary: {},
            }),
      ),
    );
    const res = await importMarineCsv(csvFile());
    expect(res.duplicate_file).toBe(true);
    expect(res.imported).toBe(0);
  });

  it('rejects when the transport itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ error: 'upload_forbidden' }, 403, 'Forbidden'),
      ),
    );
    await expect(importMarineCsv(csvFile())).rejects.toThrow(/HTTP 403/);
  });
});

describe('fetchMarineUploads / fetchMarineUpload', () => {
  it('lists the ledger with the bearer', async () => {
    const spy = vi.fn((url: string) =>
      String(url).endsWith('/auth/login')
        ? jsonResponse(loginBody)
        : jsonResponse(uploadsPage([LEDGER])),
    );
    vi.stubGlobal('fetch', spy);

    const rows = await fetchMarineUploads();
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('calls.csv');
    expect(spy.mock.calls[1][0]).toBe('/api/marine/uploads?limit=50&offset=0');
  });

  it('fetchMarineUploadsPage passes the envelope through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse(uploadsPage([LEDGER], 42)),
      ),
    );
    const res = await fetchMarineUploadsPage();
    expect(res.total).toBe(42);
  });

  it('fetches one upload with its row errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({
              ...LEDGER,
              status: 'PARTIAL',
              errors: [
                { id: 7, row_number: 2, error_message: 'bad ts', raw_data: null, created_at: null },
              ],
            }),
      ),
    );
    const { file, errors } = await fetchMarineUpload(1);
    expect(file?.status).toBe('PARTIAL');
    expect(errors).toHaveLength(1);
  });
});

describe('override import', () => {
  it('omits the override field on a NORMAL import — the body is unchanged', () => {
    const fd = buildUploadForm(new File(['x'], 'a.xml'));
    expect(fd.get('override')).toBeNull();
  });

  it('sends override=true only when asked', () => {
    const fd = buildUploadForm(new File(['x'], 'a.xml'), true);
    expect(fd.get('override')).toBe('true');
  });

  it('posts to the SAME endpoint as a normal import', async () => {
    const calls: { url: string; body: FormData }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/auth/login')) {
        return Promise.resolve({ ok: true, status: 200,
          json: async () => ({ access_token: 'T', token_type: 'bearer' }) } as Response);
      }
      calls.push({ url: String(url), body: init?.body as FormData });
      return Promise.resolve({ ok: true, status: 200,
        json: async () => ({ file_id: 1, status: 'SUCCESS', imported: 0, updated: 1 }) } as Response);
    }));

    const f = new File(['x'], 'a.xml');
    await importMarineCsv(f);
    await overrideImportMarineCsv(f);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(calls[1].url);              // same endpoint
    expect(calls[0].body.get('override')).toBeNull();     // normal import
    expect(calls[1].body.get('override')).toBe('true');   // override
  });
});
