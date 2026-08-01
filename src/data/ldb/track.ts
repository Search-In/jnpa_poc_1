/**
 * NLDS Logistics Data Bank container-track connector.
 *
 * Live call (via Vite / nginx proxy — LDB sends no usable CORS for our origin):
 *   GET {proxyBase}/apigateway/track/cntr/?cntrNo=…&mobileNo=…
 * Optional bearer: VITE_LDB_ACCESS_TOKEN (the public gateway rejects unauthenticated
 * calls with UNAUTHORIZED).
 *
 * When the live call fails and sample fallback is on, returns the bundled
 * CCLU7468361-shaped demo so the NLDS-style UI stays demoable offline.
 */

import { env } from '@/data/config';
import { mapTrackResponse } from './mapper';
import { sampleContainerTrack } from './sample';
import type { ContainerTrackResult } from './types';

export function ldbTrackUrl(cntrNo: string, mobileNo: string, proxyBase = env.ldb.proxyBase): string {
  const root = proxyBase.replace(/\/+$/, '');
  const q = new URLSearchParams({
    cntrNo: cntrNo.trim().toUpperCase(),
    mobileNo: mobileNo.trim(),
  });
  return `${root}/apigateway/track/cntr/?${q.toString()}`;
}

async function fetchLive(cntrNo: string, mobileNo: string): Promise<ContainerTrackResult> {
  if (!env.ldb.enabled) {
    throw new Error('[LDB] container track is disabled (VITE_LDB_ENABLED=false)');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.ldb.accessToken) {
    headers.Authorization = `Bearer ${env.ldb.accessToken}`;
  }

  const res = await fetch(ldbTrackUrl(cntrNo, mobileNo), { headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`[LDB] track → non-JSON body (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const detail =
      json && typeof json === 'object'
        ? JSON.stringify(json).slice(0, 240)
        : text.slice(0, 240);
    throw new Error(`[LDB] track → HTTP ${res.status} ${res.statusText} — ${detail}`);
  }

  const mapped = mapTrackResponse(json, cntrNo, false);
  if (!mapped) {
    throw new Error('[LDB] track → response had no container payload');
  }
  return mapped;
}

/**
 * Track a container by id. Prefers the live LDB gateway; falls back to the
 * bundled sample when configured.
 */
export async function trackContainerById(
  cntrNo: string,
  mobileNo: string = env.ldb.mobileNo,
): Promise<ContainerTrackResult> {
  const no = cntrNo.trim().toUpperCase();
  if (!no) throw new Error('Container number is required');

  try {
    return await fetchLive(no, mobileNo || env.ldb.mobileNo);
  } catch (err) {
    if (env.ldb.useSampleFallback) {
      return sampleContainerTrack(no);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
