/**
 * Connector registry (spec A-1, A-2, A-3). The single source of truth for the
 * Connector Readiness page: for every external source, the candidate production
 * providers, its contract version, the driver tiers available (mock / replay /
 * live), which credential env var gates "live", and a per-connector go-live
 * checklist. This is the "money screen" data — a stakeholder reads it as
 * *system complete; awaiting N credentials*.
 *
 * Pure data + small helpers; no side effects. Credential *presence* is detected
 * from build-time env (never the secret itself). Real deployment moves the live
 * drivers behind server-managed credentials (see the Security overview).
 */

import type { SourceId } from '@/provenance/sources';
import { env } from './config';

/** Driver tiers a source can run on (spec A-1). */
export type DriverTier = 'mock' | 'replay' | 'live';

/** One candidate production provider for a source. */
export interface ProviderOption {
  name: string;
  /** True for the providers we judge most probable in production. */
  probable?: boolean;
  /** True if a real request/response contract stub exists in code today. */
  contractStub?: boolean;
  docsUrl?: string;
}

export interface GoLiveStep {
  key: string;
  label: string;
}

/** The standard 5-step go-live checklist, per connector. */
export const GO_LIVE_STEPS: GoLiveStep[] = [
  { key: 'credentials', label: 'Credentials provisioned' },
  { key: 'sandbox', label: 'Sandbox test call passes' },
  { key: 'contract', label: 'Contract test (schema) passes' },
  { key: 'shadow', label: 'Shadow-run vs mock reconciled' },
  { key: 'cutover', label: 'Cutover to live' },
];

export interface ConnectorContract {
  id: SourceId;
  /** Semantic contract version for drift detection. */
  contractVersion: string;
  providers: ProviderOption[];
  /** Env var whose presence flips this source live (empty = mock only today). */
  credentialEnvVar?: string;
  /** Which tiers are actually implemented in code. */
  driversImplemented: DriverTier[];
}

export const CONNECTORS: ConnectorContract[] = [
  {
    id: 'AIS',
    contractVersion: '1.2.0',
    credentialEnvVar: 'VITE_AISSTREAM_TOKEN',
    driversImplemented: ['mock', 'live'],
    providers: [
      { name: 'ArcGIS Velocity (Kpler AIS)', probable: true, contractStub: true },
      { name: 'AISStream.io', probable: true, contractStub: true, docsUrl: 'https://aisstream.io/documentation' },
      { name: 'AISHub' },
      { name: 'MarineTraffic' },
      { name: 'VesselFinder' },
      { name: 'Global Fishing Watch' },
      { name: 'AISdb' },
    ],
  },
  {
    id: 'VTS',
    contractVersion: '0.9.0',
    driversImplemented: ['mock'],
    providers: [{ name: 'JNPA VTS movement-order feed', probable: true }, { name: 'Pilotage roster API' }],
  },
  {
    id: 'WEATHER',
    contractVersion: '1.1.0',
    credentialEnvVar: 'VITE_WEATHER_FEED_URL',
    driversImplemented: ['mock', 'live'],
    providers: [
      { name: 'IMD', probable: true },
      { name: 'MOSDAC', probable: true },
      { name: 'Open-Meteo (marine)', contractStub: true, docsUrl: 'https://open-meteo.com/en/docs/marine-weather-api' },
    ],
  },
  {
    id: 'TIDE',
    contractVersion: '1.0.0',
    driversImplemented: ['mock'],
    providers: [{ name: 'INCOIS tide predictions', probable: true }, { name: 'Copernicus Marine' }],
  },
  {
    id: 'BATHY',
    contractVersion: '1.0.0',
    driversImplemented: ['mock'],
    providers: [
      { name: 'Hydrographic survey layer', probable: true },
      { name: 'BHOONIDHI / Copernicus bathymetry' },
    ],
  },
  {
    id: 'BERTH_PLAN',
    contractVersion: '1.0.0',
    driversImplemented: ['mock', 'replay'],
    providers: [{ name: 'Port PMS berthing-plan feed', probable: true }, { name: 'CSV/XLSX upload', contractStub: true }],
  },
  {
    id: 'CRAFT',
    contractVersion: '1.0.0',
    driversImplemented: ['mock'],
    providers: [{ name: 'Marine craft roster', probable: true }],
  },
];

export const CONNECTOR_BY_ID = Object.fromEntries(CONNECTORS.map((c) => [c.id, c])) as Record<
  SourceId,
  ConnectorContract
>;

export type CredentialStatus = 'absent' | 'present';

/** Is the credential for this connector present in the current build env? */
export function credentialStatus(c: ConnectorContract): CredentialStatus {
  if (!c.credentialEnvVar) return 'absent';
  const map: Record<string, string | undefined> = {
    VITE_AISSTREAM_TOKEN: env.aisStreamToken,
    VITE_WEATHER_FEED_URL: env.weatherFeedUrl,
  };
  const v = map[c.credentialEnvVar];
  return v && v.length > 0 ? 'present' : 'absent';
}

/** Which go-live steps are satisfied for a connector, given credential status. */
export function goLiveProgress(c: ConnectorContract): Record<string, boolean> {
  const hasCred = credentialStatus(c) === 'present';
  const hasContract = c.providers.some((p) => p.contractStub);
  return {
    credentials: hasCred,
    sandbox: hasCred, // presence of a working token implies a sandbox call is possible
    contract: hasContract,
    shadow: false, // requires an operator-run shadow reconciliation
    cutover: false,
  };
}

export interface ReadinessSummary {
  total: number;
  /** Connectors whose only missing gate is credentials. */
  awaitingCredentials: number;
  liveReady: number;
}

/** Roll-up for the "system complete; awaiting N credentials" headline. */
export function readinessSummary(): ReadinessSummary {
  let awaiting = 0;
  let liveReady = 0;
  for (const c of CONNECTORS) {
    const cred = credentialStatus(c) === 'present';
    const hasLiveDriver = c.driversImplemented.includes('live');
    if (hasLiveDriver && !cred) awaiting++;
    if (hasLiveDriver && cred) liveReady++;
  }
  return { total: CONNECTORS.length, awaitingCredentials: awaiting, liveReady };
}
