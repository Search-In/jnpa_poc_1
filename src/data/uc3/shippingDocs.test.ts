import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ADVANCE_LIST_PATH,
  DELIVERY_ORDERS_PATH,
  SHIPPING_UPLOADS_PATH,
  advanceListQuery,
  deliveryOrderQuery,
  shippingUploadsQuery,
  fetchAdvanceListPage,
  fetchDeliveryOrderPage,
  fetchShippingUploadsPage,
  mapAdvanceList,
  mapDeliveryOrder,
  mapShippingUpload,
  parseAdvanceListPage,
  parseDeliveryOrderPage,
  parseShippingUploadsPage,
  type AdvanceListWire,
  type DeliveryOrderWire,
  type ShippingUploadWire,
} from './shippingDocs';
import { clearAuthToken } from './token';

const ADV: AdvanceListWire = {
  id: 41, import_file_id: 7, list_type: 'IAL', terminal: 'NSICT',
  container_no: 'MSCU1234567', iso_code: '22G1', container_valid_iso: true,
  freight_kind: 'FULL', category: 'IMPORT', gross_weight_kg: 24500.5,
  weight_source_uom: 'KG', pol: 'LKCMB', pod: 'INNSA1', destination: 'MKPP',
  shipping_line_code: 'MSC', vessel_visit: 'KMIS0276', voyage: 'S0071',
  bill_of_lading: 'MEDUXY123', seal_no: 'SL9911', reefer_status: null,
  reefer_temp: null, imdg_code: null, un_number: null, departure_mode: 'G',
  nominated_cfs: 'CFSBLC', created_at: '2026-07-20T04:30:00+00:00',
};

const DO: DeliveryOrderWire = {
  id: 88, common_ref_number: 'EDO-2026-0088', container_no: 'TGHU7654321',
  iso_code: '45G1', container_valid_iso: true, equipment_status: 'FULL',
  shipping_agent_code: 'AAACC1205A', vcn: 'INNSA1BM0R3119', imo_number: '9245678',
  loading_port: 'SGSIN', dest_port: 'INNSA1', final_pod: 'INTKD',
  delivery_mode: 'ROAD', gate_pass_no: 'GP-4471', vehicle_no: 'MH04AB1234',
  gate_number: 'G3', arrival_ts: '2026-07-18T22:10:00+00:00',
  receipt_date: '2026-07-19T00:00:00+00:00', gate_pass_ts: '2026-07-19T09:15:00+00:00',
  issued_ts: '2026-07-19T06:00:00+00:00', created_at: '2026-07-19T06:00:05+00:00',
};

const UP: ShippingUploadWire = {
  id: 12, source_file: 'NSICT_IAL_20260720.csv', list_type: 'IAL', terminal: 'NSICT',
  physical_format: 'CSV', record_count: 420, imported_count: 418, error_count: 2,
  import_status: 'PARTIAL', error_detail: null, uploaded_by: 'ops1', source: 'UPLOAD',
  created_at: '2026-07-20T05:00:00+00:00',
};

const env = <T,>(items: T[], total = items.length) =>
  ({ items, total, limit: 1000, offset: 0, count: items.length });

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapAdvanceList (wire → domain)', () => {
  it('maps a full row', () => {
    const r = mapAdvanceList(ADV)!;
    expect(r).toMatchObject({
      id: '41', listType: 'IAL', terminal: 'NSICT', containerNo: 'MSCU1234567',
      freightKind: 'FULL', category: 'IMPORT', grossWeightKg: 24500.5,
      pod: 'INNSA1', shippingLineCode: 'MSC', vesselVisit: 'KMIS0276',
      voyage: 'S0071', billOfLading: 'MEDUXY123', containerValidIso: true,
    });
    expect(r.createdAt).toBeGreaterThan(0);
  });

  it('KEEPS a row with no id, deriving a key from the business fields', () => {
    // Regression: returning null here made docPage() filter the row out, so a payload
    // of thousands of valid rows without `id` rendered as an empty "0 of 0" table.
    const r = mapAdvanceList({ ...ADV, id: null }, 7);
    expect(r).not.toBeNull();
    expect(r.containerNo).toBe('MSCU1234567');
    expect(r.id).toBe('MSCU1234567|MEDUXY123#7');
  });

  it('accepts a string id (bigint serialisation differs by driver)', () => {
    expect(mapAdvanceList({ ...ADV, id: '9007199254740993' }).id).toBe('9007199254740993');
  });

  it('keeps absent numerics as null, not 0', () => {
    const r = mapAdvanceList({ ...ADV, gross_weight_kg: null, reefer_temp: null })!;
    expect(r.grossWeightKg).toBeNull();
    expect(r.reeferTemp).toBeNull();
  });

  it('coerces null text to empty string and null booleans to false', () => {
    const r = mapAdvanceList({ ...ADV, pod: null, voyage: null, container_valid_iso: null })!;
    expect(r.pod).toBe('');
    expect(r.voyage).toBe('');
    expect(r.containerValidIso).toBe(false);
  });

  it('yields createdAt 0 for an unparseable timestamp', () => {
    expect(mapAdvanceList({ ...ADV, created_at: 'not-a-date' })!.createdAt).toBe(0);
  });
});

describe('mapDeliveryOrder (wire → domain)', () => {
  it('maps a full row', () => {
    const r = mapDeliveryOrder(DO)!;
    expect(r).toMatchObject({
      id: '88', commonRefNumber: 'EDO-2026-0088', containerNo: 'TGHU7654321',
      equipmentStatus: 'FULL', shippingAgentCode: 'AAACC1205A',
      vcn: 'INNSA1BM0R3119', destPort: 'INNSA1', gatePassNo: 'GP-4471',
      vehicleNo: 'MH04AB1234',
    });
    expect(r.gatePassTs).toBeGreaterThan(0);
    expect(r.receiptDate).toBeGreaterThan(0);
  });

  it('KEEPS a row with no id, deriving a key from the business fields', () => {
    const r = mapDeliveryOrder({ ...DO, id: null }, 3);
    expect(r.containerNo).toBe('TGHU7654321');
    expect(r.id).toBe('EDO-2026-0088|TGHU7654321#3');
  });

  it('yields 0 for every absent timestamp', () => {
    const r = mapDeliveryOrder({
      ...DO, arrival_ts: null, receipt_date: null, gate_pass_ts: null, issued_ts: null,
    })!;
    expect([r.arrivalTs, r.receiptDate, r.gatePassTs, r.issuedTs]).toEqual([0, 0, 0, 0]);
  });
});

describe('mapShippingUpload (wire → domain)', () => {
  it('maps a full row', () => {
    const r = mapShippingUpload(UP)!;
    expect(r).toMatchObject({
      id: '12', sourceFile: 'NSICT_IAL_20260720.csv', listType: 'IAL',
      physicalFormat: 'CSV', recordCount: 420, importedCount: 418,
      errorCount: 2, importStatus: 'PARTIAL', uploadedBy: 'ops1', source: 'UPLOAD',
    });
  });

  it('KEEPS a row with no id, deriving a key from the file name', () => {
    expect(mapShippingUpload({ ...UP, id: null }, 0).id).toBe('NSICT_IAL_20260720.csv#0');
  });

  it('counts default to 0, never NaN', () => {
    const r = mapShippingUpload({ ...UP, record_count: null, imported_count: null, error_count: null })!;
    expect([r.recordCount, r.importedCount, r.errorCount]).toEqual([0, 0, 0]);
  });
});

describe('parse*Page (envelope handling)', () => {
  it('preserves server order and passes total through', () => {
    const p = parseAdvanceListPage(env([ADV, { ...ADV, id: 42, container_no: 'ZZZU0000001' }], 900));
    expect(p.items.map((r) => r.containerNo)).toEqual(['MSCU1234567', 'ZZZU0000001']);
    expect(p.total).toBe(900);
  });

  it('renders EVERY row even when the server sends no id at all', () => {
    // The exact reported failure: 200 OK with thousands of rows -> "0-0 of 0".
    const noIds = Array.from({ length: 2500 }, (_, i) => ({ ...ADV, id: null, container_no: `BOXU000${i}` }));
    const p = parseAdvanceListPage(env(noIds, 2500));
    expect(p.items).toHaveLength(2500);
    expect(p.skipped).toBe(0);
    expect(new Set(p.items.map((r) => r.id)).size).toBe(2500); // keys stay unique
  });

  it('counts — never hides — rows that are not objects at all', () => {
    const p = parseAdvanceListPage(env([ADV, null, 'nope'] as never[], 3));
    expect(p.items).toHaveLength(1);
    expect(p.skipped).toBe(2);
  });

  it('tolerates a malformed payload', () => {
    for (const parse of [parseAdvanceListPage, parseDeliveryOrderPage, parseShippingUploadsPage]) {
      expect(parse(null).items).toEqual([]);
      expect(parse({ items: 'nope' }).items).toEqual([]);
    }
  });

  it('falls back to the requested limit when the envelope omits it', () => {
    expect(parseDeliveryOrderPage({ items: [DO] }, 250).limit).toBe(250);
  });
});

describe('query builders — only parameters the gateway accepts', () => {
  it('advance list: page window only when unfiltered', () => {
    expect(advanceListQuery()).toBe(`${ADVANCE_LIST_PATH}?limit=1000&offset=0`);
  });

  it('advance list: emits every supported filter and omits blanks', () => {
    const q = advanceListQuery({
      listType: 'IAL', terminal: 'NSICT', category: 'IMPORT', freightKind: 'FULL',
      shippingLine: 'MSC', q: 'MSCU', container: '', bl: '   ',
    });
    expect(q).toContain('list_type=IAL');
    expect(q).toContain('terminal=NSICT');
    expect(q).toContain('category=IMPORT');
    expect(q).toContain('freight_kind=FULL');
    expect(q).toContain('shipping_line=MSC');
    expect(q).toContain('q=MSCU');
    expect(q).not.toContain('container=');
    expect(q).not.toContain('bl=');
  });

  it('advance list: never sends pod / voyage / vessel_visit / dates — the gateway has no such filters', () => {
    const q = advanceListQuery({ listType: 'EAL' });
    for (const unsupported of ['pod=', 'voyage=', 'vessel_visit=', 'date', 'sort=']) {
      expect(q).not.toContain(unsupported);
    }
  });

  it('delivery orders: only container and vehicle', () => {
    expect(deliveryOrderQuery()).toBe(`${DELIVERY_ORDERS_PATH}?limit=1000&offset=0`);
    const q = deliveryOrderQuery({ container: 'TGHU7654321', vehicle: 'MH04AB1234' });
    expect(q).toContain('container=TGHU7654321');
    expect(q).toContain('vehicle=MH04AB1234');
  });

  it('uploads: list_type / status / source, default limit 200', () => {
    expect(shippingUploadsQuery()).toBe(`${SHIPPING_UPLOADS_PATH}?limit=200&offset=0`);
    const q = shippingUploadsQuery({ listType: 'EDO', status: 'FAILED', source: 'DIRECTORY' });
    expect(q).toContain('list_type=EDO');
    expect(q).toContain('status=FAILED');
    expect(q).toContain('source=DIRECTORY');
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  const stub = (body: unknown) =>
    vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(body));

  it('advance lists: sends the bearer and the built URL', async () => {
    const spy = stub(env([ADV], 137));
    vi.stubGlobal('fetch', spy);
    const page = await fetchAdvanceListPage({ listType: 'IAL' }, 1000, 0);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(137);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/shipping-lines?list_type=IAL&limit=1000&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test.jwt.token');
  });

  it('delivery orders: maps the envelope', async () => {
    vi.stubGlobal('fetch', stub(env([DO], 4)));
    const page = await fetchDeliveryOrderPage();
    expect(page.items[0].commonRefNumber).toBe('EDO-2026-0088');
    expect(page.total).toBe(4);
  });

  it('uploads: maps the ledger', async () => {
    vi.stubGlobal('fetch', stub(env([UP], 1)));
    const page = await fetchShippingUploadsPage({ status: 'PARTIAL' });
    expect(page.items[0].sourceFile).toBe('NSICT_IAL_20260720.csv');
  });

  it('rejects on transport failure so the caller can show an error state', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse({ error: 'x' }, 403, 'Forbidden')));
    await expect(fetchAdvanceListPage()).rejects.toThrow(/HTTP 403/);
  });
});
