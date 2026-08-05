import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  clearSearateToken,
  decodeJwtPayload,
  generateSearateOtp,
  getSearateToken,
  mobileNoFromToken,
  setSearateToken,
  verifySearateOtp,
} from './token';

/** Minimal unsigned JWT with mobileNo claim (header.payload.sig). */
function fakeJwt(mobileNo: string): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ mobileNo }));
  return `${header}.${payload}.sig`;
}

describe('JWT helpers', () => {
  it('decodes mobileNo from searateToken payload', () => {
    const jwt = fakeJwt('9876543210');
    expect(decodeJwtPayload(jwt)?.mobileNo).toBe('9876543210');
    expect(mobileNoFromToken(jwt)).toBe('9876543210');
  });
});

describe('searateToken session', () => {
  beforeEach(() => {
    clearSearateToken();
  });

  afterEach(() => {
    clearSearateToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores and reuses one bearer for any container', () => {
    setSearateToken('Bearer SHARED.JWT');
    expect(getSearateToken()).toBe('SHARED.JWT');
    expect(getSearateToken()).toBe('SHARED.JWT');
  });

  it('generateSearateOtp hits otp-sms/generate', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await generateSearateOtp('9876543210');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0] as unknown as [string]);
    expect(url).toContain('/apigateway/otp-sms/generate');
    expect(url).toContain('mobileNo=9876543210');
  });

  it('verifySearateOtp stores jwtToken like LDB sessionStorage', async () => {
    const jwt = fakeJwt('9876543210');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ jwtToken: jwt }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const token = await verifySearateOtp('9876543210', '123456');
    expect(token).toBe(jwt);
    expect(getSearateToken()).toBe(jwt);
    expect(mobileNoFromToken()).toBe('9876543210');
    const url = String(fetchMock.mock.calls[0] as unknown as [string]);
    expect(url).toContain('/apigateway/otp-sms/verify');
    expect(url).toContain('otp=123456');
  });

  it('rejects bad mobile / OTP shapes without calling LDB', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateSearateOtp('123')).rejects.toThrow(/10-digit/);
    await expect(verifySearateOtp('9876543210', '12')).rejects.toThrow(/6-digit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
