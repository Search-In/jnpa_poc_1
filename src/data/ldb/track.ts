/**
 * NLDS Logistics Data Bank container-track connector.
 *
 * Same auth + API as ldb.co.in guest searate:
 *   POST {proxy}/apigateway/track/cntr/?cntrNo=…&mobileNo=…
 *   Authorization: Bearer <sessionStorage.searateToken>
 *
 * Token comes from mobile OTP (`otp-sms/generate` + `otp-sms/verify`). One
 * verified session tracks ANY container until LDB returns 401.
 */

import { env } from '@/data/config';
import { mapTrackResponse } from './mapper';
import { SAMPLE_CONTAINER_NO, sampleContainerTrack } from './sample';
import {
  clearSearateToken,
  getSearateToken,
  LdbAuthRequiredError,
  mobileNoFromToken,
} from './token';
import type { ContainerTrackResult } from './types';

/** ISO 6346 owner-code + serial + check digit: 4 letters + 7 digits (e.g. CCLU7468361). */
export function isValidContainerNo(raw: string): boolean {
  return /^[A-Z]{4}\d{7}$/.test(raw.trim().toUpperCase());
}

export function ldbTrackUrl(cntrNo: string, mobileNo: string, proxyBase = env.ldb.proxyBase): string {
  const root = proxyBase.replace(/\/+$/, '');
  const q = new URLSearchParams({
    cntrNo: cntrNo.trim().toUpperCase(),
    mobileNo: mobileNo.trim(),
  });
  return `${root}/apigateway/track/cntr/?${q.toString()}`;
}

function isUnauthorizedPayload(json: unknown, status: number): boolean {
  if (status === 401 || status === 403) return true;
  if (!json || typeof json !== 'object') return false;
  const rec = json as Record<string, unknown>;
  const code = String(rec.statusCode ?? rec.status ?? '').toUpperCase();
  const err = String(rec.error ?? rec.description ?? rec.message ?? '').toUpperCase();
  return (
    code === 'UNAUTHORIZED' ||
    err.includes('UNAUTHORIZED') ||
    err.includes('TOKEN VALIDATION') ||
    err.includes('ACCESS DENIED') ||
    err.includes('TOKEN EXPIRE')
  );
}

async function fetchTrackOnce(
  cntrNo: string,
  mobileNo: string,
  bearer: string,
): Promise<ContainerTrackResult> {
  // LDB Angular client uses POST (empty body) + query params — match that.
  const res = await fetch(ldbTrackUrl(cntrNo, mobileNo), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: '{}',
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Couldn’t look up this container. Please try again.');
  }

  if (isUnauthorizedPayload(json, res.status)) {
    clearSearateToken();
    throw new LdbAuthRequiredError(
      'Your session expired. Please verify your mobile number again.',
    );
  }

  if (!res.ok) {
    throw new Error('Couldn’t look up this container. Please try again.');
  }

  const mapped = mapTrackResponse(json, cntrNo, false);
  if (!mapped) {
    throw new Error('No tracking details found for this container.');
  }
  return mapped;
}

async function fetchLive(cntrNo: string, mobileNoHint: string): Promise<ContainerTrackResult> {
  if (!env.ldb.enabled) {
    throw new Error('Container tracking is currently unavailable.');
  }

  const bearer = getSearateToken();
  if (!bearer) {
    throw new LdbAuthRequiredError(
      'Please verify your mobile number to track a container.',
    );
  }

  // Prefer mobile from the signed-in session over the form hint.
  const mobile = mobileNoFromToken(bearer) || mobileNoHint.trim() || env.ldb.mobileNo;
  if (!mobile) {
    throw new LdbAuthRequiredError('Please verify your mobile number again.');
  }

  return fetchTrackOnce(cntrNo, mobile, bearer);
}

/**
 * Track a container by id. Requires an OTP-verified searateToken (shared for
 * every container until expiry).
 */
export async function trackContainerById(
  cntrNo: string,
  mobileNo: string = env.ldb.mobileNo,
): Promise<ContainerTrackResult> {
  const no = cntrNo.trim().toUpperCase();
  if (!no) throw new Error('Container number is required');
  if (!isValidContainerNo(no)) {
    throw new Error('Enter a valid container number (4 letters + 7 digits, e.g. CCLU7468361)');
  }

  try {
    return await fetchLive(no, mobileNo || env.ldb.mobileNo);
  } catch (err) {
    if (err instanceof LdbAuthRequiredError) throw err;
    if (env.ldb.useSampleFallback && no === SAMPLE_CONTAINER_NO) {
      return sampleContainerTrack();
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      reason.startsWith('Couldn’t') || reason.startsWith('No tracking') || reason.startsWith('Enter')
        ? reason
        : `Couldn’t track ${no}. Please try again.`,
    );
  }
}

export { LdbAuthRequiredError };
