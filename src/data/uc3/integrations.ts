/**
 * JNPA Port-Data API integration-status connector — the read-only health surface
 * for the gateway's Port-Data ingestion (Phase 5 of the JNPA API integration).
 *
 * `GET /api/integrations/jnpa/health` reports whether the gateway has the
 * upstream JNPA Port-Data API configured, which mode it runs in
 * (LIVE / SIM / DISABLED), the per-group sync watermarks, and the last
 * ingestion run. UC-1 renders it as ONE read-only card (ConnectorReadiness);
 * nothing here mutates gateway state.
 *
 * Structured like liveVessels.ts / marineDashboard.ts: endpoint constant, typed
 * *wire* shapes (snake_case), exported PURE mappers, I/O last — every mapping
 * unit-testable with no network. Auth (bearer + the one-shot 401 re-login) is
 * handled by `client.http()`.
 */

import { http } from './client';

/** Path suffix, relative to `env.uc3.apiBase` (so '/api' is NOT repeated here). */
export const JNPA_INTEGRATION_HEALTH_PATH = '/integrations/jnpa/health';

/** Gateway-reported run mode for the Port-Data integration. */
export type JnpaIntegrationMode = 'LIVE' | 'SIM' | 'DISABLED';

/** One ingestion group's sync state (e.g. vessel-calls, berthing, tides). */
export interface JnpaIntegrationGroup {
  group: string;
  kind: string;
  /** High-water mark of ingested upstream data (epoch ms; 0 = never synced). */
  watermarkTs: number;
  /** Outcome of the group's last pull, e.g. 'ok' / 'error'. '' when unknown. */
  lastStatus: string;
  /** When the group row itself last changed (epoch ms; 0 unknown). */
  updatedAt: number;
}

/** The most recent ingestion run, when the gateway has run at least once. */
export interface JnpaIntegrationRun {
  status: string;
  startedAt: number;
  finishedAt: number;
  trigger: string;
  /** Free-text detail; the gateway's `error` field when a run failed. */
  detail: string;
}

export interface JnpaIntegrationHealth {
  /** True when the gateway holds upstream credentials/URL for the JNPA API. */
  configured: boolean;
  mode: JnpaIntegrationMode;
  /** Upstream base URL as the gateway sees it ('' when not configured). */
  apiUrl: string;
  groups: JnpaIntegrationGroup[];
  /** Null when the integration has never run. */
  lastRun: JnpaIntegrationRun | null;
}

// ------------------------------------------------------------------ pure helpers
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function ts(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise the wire mode onto the closed union. Anything unrecognised maps to
 * DISABLED — the honest floor: a mode this build does not know about must never
 * badge itself LIVE.
 */
export function parseJnpaMode(v: unknown): JnpaIntegrationMode {
  const m = str(v).toUpperCase();
  return m === 'LIVE' || m === 'SIM' ? m : 'DISABLED';
}

function parseRun(raw: unknown): JnpaIntegrationRun | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  return {
    status: str(r['status']),
    startedAt: ts(r['started_at']),
    finishedAt: ts(r['finished_at']),
    trigger: str(r['trigger']),
    detail: str(r['detail']) || str(r['error']),
  };
}

/** Map the whole health payload. Pure and tolerant: any malformed section
 * degrades to its empty/disabled shape rather than throwing mid-render. */
export function parseJnpaIntegrationHealth(raw: unknown): JnpaIntegrationHealth {
  const r = raw as Record<string, unknown> | null;
  const groups = Array.isArray(r?.['groups']) ? (r!['groups'] as Record<string, unknown>[]) : [];
  return {
    configured: r?.['configured'] === true,
    mode: parseJnpaMode(r?.['mode']),
    apiUrl: str(r?.['api_url']),
    groups: groups
      .filter((w) => str(w['group']) !== '')
      .map((w) => ({
        group: str(w['group']),
        kind: str(w['kind']),
        watermarkTs: ts(w['watermark_ts']),
        lastStatus: str(w['last_status']),
        updatedAt: ts(w['updated_at']),
      })),
    lastRun: parseRun(r?.['last_run']),
  };
}

/** How many groups have ever synced (carry a watermark). Pure — feeds the
 * "9/13 groups synced" readout without the component re-deriving it. */
export function syncedGroupCount(groups: JnpaIntegrationGroup[]): number {
  return groups.filter((g) => g.watermarkTs > 0).length;
}

// ------------------------------------------------------------------ fetcher (I/O last)
/**
 * Fetch the JNPA Port-Data API integration health from the shared gateway.
 *
 * @throws when UC-3 is disabled, the login fails, or the gateway is non-2xx —
 *         callers rendering status must catch and show "unavailable" quietly.
 */
export async function fetchJnpaIntegrationHealth(): Promise<JnpaIntegrationHealth> {
  return parseJnpaIntegrationHealth(await http<unknown>(JNPA_INTEGRATION_HEALTH_PATH));
}
