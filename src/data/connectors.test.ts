import { describe, it, expect } from 'vitest';
import {
  CONNECTORS,
  CONNECTOR_BY_ID,
  credentialStatus,
  goLiveProgress,
  readinessSummary,
  GO_LIVE_STEPS,
} from './connectors';

describe('connector registry', () => {
  it('covers all seven sources with a contract version and providers', () => {
    expect(CONNECTORS).toHaveLength(7);
    for (const c of CONNECTORS) {
      expect(c.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.providers.length).toBeGreaterThan(0);
      expect(c.driversImplemented).toContain('mock');
    }
  });

  it('AIS lists at least two providers with real contract stubs', () => {
    const ais = CONNECTOR_BY_ID.AIS;
    const withStub = ais.providers.filter((p) => p.contractStub);
    expect(withStub.length).toBeGreaterThanOrEqual(2);
  });

  it('credentialStatus is absent when the env var is empty (mock default)', () => {
    // In test/mock env the tokens are blank → absent.
    expect(credentialStatus(CONNECTOR_BY_ID.AIS)).toBe('absent');
    expect(credentialStatus(CONNECTOR_BY_ID.VTS)).toBe('absent'); // no cred var at all
  });

  it('goLiveProgress marks contract done where a stub exists, shadow/cutover pending', () => {
    const p = goLiveProgress(CONNECTOR_BY_ID.AIS);
    expect(p.contract).toBe(true);
    expect(p.shadow).toBe(false);
    expect(p.cutover).toBe(false);
  });

  it('readinessSummary reports live-ready connectors awaiting credentials', () => {
    const s = readinessSummary();
    expect(s.total).toBe(7);
    // AIS + WEATHER have live drivers but no creds in mock env → awaiting.
    expect(s.awaitingCredentials).toBeGreaterThanOrEqual(2);
    expect(s.liveReady).toBe(0);
  });

  it('exposes the standard 5-step go-live checklist', () => {
    expect(GO_LIVE_STEPS.map((s) => s.key)).toEqual([
      'credentials',
      'sandbox',
      'contract',
      'shadow',
      'cutover',
    ]);
  });
});
