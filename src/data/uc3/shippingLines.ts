/**
 * UC-3 Shipping Lines connector — the shared JNPA carrier registry.
 *
 * Reads `GET /api/shipping-lines/lines` (RBAC: control room + customs) and maps
 * the gateway's wire rows onto the UC-1 domain type. Structured like aishub.ts:
 * endpoint constants, a typed *wire* interface kept separate from the domain
 * type, exported PURE mappers, and the I/O function last — so the mapping is
 * unit-testable with no network and no fetch stub.
 *
 * Backing store: `jnpa.shipping_lines`, populated by the gateway's advance-list
 * (IAL/EAL) importer. Two source-data facts the mapping has to absorb:
 *
 *  • **`line_name` is always null.** The importer upserts `line_code` only, so
 *    the registry has codes and no names. `lineName` therefore falls back to the
 *    code — a UI showing "KMD" where a carrier name is expected is correct, not
 *    a bug. Populating real names needs a source outside UC-3.
 *
 *  • **Rows arrive pre-sorted** (`ORDER BY container_count DESC, line_code`), so
 *    callers need no client-side sort. The order is preserved by the mapper.
 */

import type { ShippingLine } from '@/types/domain';
import { http } from './client';

/** Endpoint suffix, relative to `env.uc3.apiBase`. */
export const SHIPPING_LINES_PATH = '/shipping-lines/lines';

/**
 * The registry is small (tens of carriers), and the gateway caps `limit` at
 * 1000 — so one request fetches the whole list and no pagination loop is needed.
 */
export const SHIPPING_LINES_PAGE_LIMIT = 1000;

/** One row exactly as the gateway returns it. Snake_case: this is the wire shape. */
export interface ShippingLineWire {
  line_code: string;
  /** Always null in practice — see the module note. */
  line_name: string | null;
  source: string | null;
  /** ISO-8601 with offset. */
  first_seen: string | null;
  last_seen: string | null;
  container_count: number | null;
}

/** The gateway's standard paged envelope. */
export interface ShippingLinesPage {
  items: ShippingLineWire[];
  /** Full matching count, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
  /** Number of items on THIS page. */
  count: number;
}

/**
 * ISO-8601 → epoch ms. Returns 0 (not NaN) when absent or unparseable, so a bad
 * timestamp can never poison downstream date formatting; consumers treat 0 as
 * "unknown". Same fallback-to-0 posture as `num()` in src/data/config.ts.
 */
export function toEpochMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Map one wire row onto the domain type. Pure.
 *
 * Returns null for a row with no `line_code` — the primary key and the only
 * field the UI can key on — rather than surfacing a blank entry. (Same
 * drop-the-unusable-record posture as `mapAisHubPosition` in aishub.ts.)
 */
export function mapShippingLine(w: ShippingLineWire): ShippingLine | null {
  const lineCode = (w?.line_code ?? '').trim();
  if (!lineCode) return null;
  const name = (w.line_name ?? '').trim();
  return {
    lineCode,
    // Fall back to the code: line_name is null for every row today.
    lineName: name || lineCode,
    source: w.source ?? '',
    firstSeen: toEpochMs(w.first_seen),
    lastSeen: toEpochMs(w.last_seen),
    containerCount: Number(w.container_count ?? 0),
  };
}

/**
 * Map a whole response envelope, dropping unusable rows and preserving the
 * server's ordering. Pure and tolerant: a malformed or empty payload yields [].
 */
export function parseShippingLinesPage(raw: unknown): ShippingLine[] {
  const items = (raw as ShippingLinesPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map(mapShippingLine)
    .filter((l): l is ShippingLine => l !== null);
}

/** Build the query string for one page of the registry. Pure. */
export function shippingLinesQuery(limit = SHIPPING_LINES_PAGE_LIMIT, offset = 0): string {
  return `${SHIPPING_LINES_PATH}?limit=${limit}&offset=${offset}`;
}

/**
 * Fetch the shipping-line registry from the UC-3 backend, newest/busiest first.
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchShippingLines(
  limit = SHIPPING_LINES_PAGE_LIMIT,
  offset = 0,
): Promise<ShippingLine[]> {
  const page = await http<ShippingLinesPage>(shippingLinesQuery(limit, offset));
  return parseShippingLinesPage(page);
}
