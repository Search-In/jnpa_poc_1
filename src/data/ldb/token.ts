/**
 * LDB SeaRate auth — same flow as ldb.co.in guest searate UI.
 *
 *  1. GET  /apigateway/otp-sms/generate?mobileNo=…
 *  2. GET  /apigateway/otp-sms/verify?mobileNo=…&otp=…  → { jwtToken }
 *  3. sessionStorage.searateToken = jwtToken
 *  4. POST /apigateway/track/cntr/?cntrNo=…&mobileNo=…  Authorization: Bearer <jwt>
 *
 * The JWT is mobile-scoped (claim `mobileNo`), not container-scoped — one OTP
 * session tracks any container until LDB returns 401 (token expired).
 */

import { env } from '@/data/config';

/** Same key LDB's Angular app uses in sessionStorage. */
export const SEARATE_TOKEN_KEY = 'searateToken';

let memoryToken: string | null = null;

export class LdbAuthRequiredError extends Error {
  readonly needsAuth = true;
  constructor(message = 'Please verify your mobile number to continue') {
    super(message);
    this.name = 'LdbAuthRequiredError';
  }
}

function ldbUrl(path: string): string {
  const root = env.ldb.proxyBase.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${root}${suffix}`;
}

/** Prefer a short reason over gateway HTML bodies in the UI. */
function formatLdbHttpError(step: string, status: number, body: string): string {
  if (status === 403) {
    return 'Request was blocked. Refresh the page and try again.';
  }
  if (status === 429 || /limit exceeded/i.test(body)) {
    return 'Too many attempts. Please try again later.';
  }
  if (/^\s*</.test(body) || status >= 500) {
    return 'Service is temporarily unavailable. Please try again.';
  }
  if (step.includes('verify')) {
    return 'Couldn’t verify the code. Check it and try again.';
  }
  return 'Couldn’t send the code. Check the mobile number and try again.';
}

function readSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SEARATE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeSessionToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SEARATE_TOKEN_KEY, token);
    else sessionStorage.removeItem(SEARATE_TOKEN_KEY);
  } catch {
    /* private mode / SSR — memory cache still works for the tab session */
  }
}

export function clearSearateToken(): void {
  memoryToken = null;
  writeSessionToken(null);
}

export function setSearateToken(token: string): void {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  memoryToken = t;
  writeSessionToken(t);
}

/**
 * Resolve the shared SeaRate bearer. Order: memory → sessionStorage → optional
 * env bootstrap (paste from an LDB session). Does NOT call OTP by itself.
 */
export function getSearateToken(): string | null {
  if (memoryToken) return memoryToken;
  const fromSession = readSessionToken();
  if (fromSession) {
    memoryToken = fromSession;
    return fromSession;
  }
  const bootstrap = env.ldb.accessToken.trim().replace(/^Bearer\s+/i, '');
  if (bootstrap) {
    memoryToken = bootstrap;
    writeSessionToken(bootstrap);
    return bootstrap;
  }
  return null;
}

export function hasSearateSession(): boolean {
  return Boolean(getSearateToken());
}

/** Decode JWT payload (no verify) — LDB puts `mobileNo` in the claim set. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = atob(pad);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function mobileNoFromToken(token: string | null = getSearateToken()): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const m = payload?.mobileNo ?? payload?.mobile_no ?? payload?.mobile;
  return m != null && String(m).trim() ? String(m).trim() : null;
}

/** GET /apigateway/otp-sms/generate?mobileNo= — LDB sends the SMS OTP. */
export async function generateSearateOtp(mobileNo: string): Promise<void> {
  const mobile = mobileNo.trim();
  if (!/^\d{10}$/.test(mobile)) {
    throw new Error('Enter a valid 10-digit Indian mobile number');
  }
  const url = `${ldbUrl('/apigateway/otp-sms/generate')}?${new URLSearchParams({ mobileNo: mobile })}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(formatLdbHttpError('OTP generate', res.status, text));
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* empty / non-JSON success is fine */
  }
  const rec = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (rec?.isError === true) {
    throw new Error(String(rec.message ?? 'Couldn’t send the code. Please try again.'));
  }
}

/**
 * GET /apigateway/otp-sms/verify?mobileNo=&otp= → { jwtToken }
 * Stores the token like LDB (`sessionStorage.searateToken`).
 */
export async function verifySearateOtp(mobileNo: string, otp: string): Promise<string> {
  const mobile = mobileNo.trim();
  const code = otp.trim();
  if (!/^\d{10}$/.test(mobile)) {
    throw new Error('Enter a valid 10-digit Indian mobile number');
  }
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Enter the 6-digit verification code');
  }
  const url = `${ldbUrl('/apigateway/otp-sms/verify')}?${new URLSearchParams({
    mobileNo: mobile,
    otp: code,
  })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Couldn’t verify the code. Please try again.');
  }
  if (!res.ok) {
    throw new Error(formatLdbHttpError('OTP verify', res.status, text));
  }
  const rec = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (rec?.isError === true) {
    throw new Error(String(rec.message ?? 'Couldn’t verify the code. Please try again.'));
  }
  const jwt =
    (typeof rec?.jwtToken === 'string' && rec.jwtToken) ||
    (typeof rec?.token === 'string' && rec.token) ||
    (typeof rec?.accessToken === 'string' && rec.accessToken) ||
    null;
  if (!jwt) {
    throw new Error('Couldn’t complete sign-in. Please try again.');
  }
  setSearateToken(jwt);
  return jwt;
}
