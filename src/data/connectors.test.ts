import { describe, it, expect } from 'vitest';
import {
  CONNECTORS,
  CONNECTOR_BY_ID,
  credentialStatus,
  goLiveProgress,
  readinessSummary,
  GO_LIVE_STEPS,
} from './connectors';
import { SOURCES, SOURCE_BY_ID } from '@/provenance/sources';

describe('connector registry', () => {
  it('covers every source with a contract version and providers', () => {
    // 7 marine feeds + SHIPPING_LINE (shared JNPA backend).
    expect(CONNECTORS).toHaveLength(8);
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
    expect(s.total).toBe(8);
    // AIS + WEATHER have live drivers but no creds in mock env → awaiting.
    expect(s.awaitingCredentials).toBeGreaterThanOrEqual(2);
    expect(s.liveReady).toBe(0);
  });

  it('registers SHIPPING_LINE with a live driver and a real contract stub', () => {
    const sl = CONNECTOR_BY_ID.SHIPPING_LINE;
    expect(sl).toBeDefined();
    expect(sl.driversImplemented).toEqual(['mock', 'live']);
    // No third-party API key to provision — the live driver reads the shared
    // JNPA backend, so this connector declares no credentialEnvVar.
    expect(sl.credentialEnvVar).toBeUndefined();
    // The contract is not aspirational: src/data/uc3/ implements and tests it.
    expect(goLiveProgress(sl).contract).toBe(true);
  });

  it('every connector has provenance metadata (registries stay in sync)', () => {
    // ConnectorReadiness renders SOURCE_BY_ID[c.id] directly, so a connector
    // without a matching SOURCES entry would be an undefined lookup at runtime.
    for (const c of CONNECTORS) {
      expect(SOURCE_BY_ID[c.id], `no SOURCES entry for ${c.id}`).toBeDefined();
      expect(SOURCE_BY_ID[c.id].label).toBeTruthy();
    }
    expect(CONNECTORS.length).toBe(SOURCES.length);
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
