/**
 * <ConnectorReadiness> — the "money screen" for a ready solution provider
 * (spec A-2). For every source it shows: contract version, driver tiers
 * implemented (mock/replay/live), candidate providers (probable + which have a
 * real contract stub), credential status (absent/present), the live source rung,
 * and a per-connector go-live checklist. A headline reads *system complete;
 * awaiting N credentials*.
 *
 * SCOPE HONESTY: credential status reflects build-time env presence only; the
 * "shadow" and "cutover" steps require an operator action and are shown pending.
 * Live drivers exist for AIS + weather; the rest are mock with a documented
 * contract to bring live.
 */
import { useEffect, useState } from 'react';
import { CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import {
  CONNECTORS,
  GO_LIVE_STEPS,
  credentialStatus,
  goLiveProgress,
  readinessSummary,
  type DriverTier,
} from '@/data/connectors';
import {
  fetchJnpaIntegrationHealth,
  syncedGroupCount,
  type JnpaIntegrationHealth,
  type JnpaIntegrationMode,
} from '@/data/uc3/integrations';
import { SOURCE_BY_ID, rungLabel } from '@/provenance/sources';
import { useDataModeStore } from '@/provenance/useDataModeStore';
import { tokens } from '@/theme/tokens';

const TIER_COLOR: Record<DriverTier, string> = {
  mock: tokens.textMuted,
  replay: tokens.accent,
  live: tokens.good,
};

const JNPA_MODE_COLOR: Record<JnpaIntegrationMode, string> = {
  LIVE: tokens.mode.LIVE,
  SIM: tokens.mode.SIM,
  DISABLED: tokens.offline,
};

/**
 * Read-only status card for the gateway's JNPA Port-Data API integration
 * (GET /api/integrations/jnpa/health) — real gateway state, unlike the
 * simulated connector rungs below it. Fetched once on mount; when the gateway
 * is down or UC-3 is disabled it degrades to a quiet "unavailable" line.
 */
function JnpaApiStatusCard() {
  const [health, setHealth] = useState<JnpaIntegrationHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchJnpaIntegrationHealth()
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: JnpaIntegrationMode = health?.mode ?? 'DISABLED';
  const synced = health ? syncedGroupCount(health.groups) : 0;

  return (
    <div
      style={{
        padding: '10px 14px',
        background: tokens.panelAlt,
        border: `1px solid ${tokens.border}`,
        borderLeft: `3px solid ${failed ? tokens.border : JNPA_MODE_COLOR[mode]}`,
        borderRadius: tokens.radius.sm,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <CalciteIcon icon="data-check" scale="m" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>JNPA Port-Data API</span>
          {!failed && health && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 3,
                border: `1px solid ${JNPA_MODE_COLOR[mode]}`,
                color: JNPA_MODE_COLOR[mode],
              }}
            >
              {mode}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: tokens.textMuted }}>
          {failed
            ? 'unavailable — gateway not reachable'
            : !health
              ? 'checking…'
              : `last run: ${health.lastRun ? health.lastRun.status || 'unknown' : 'never'} · ${synced}/${health.groups.length} groups synced`}
        </div>
      </div>
    </div>
  );
}

export function ConnectorReadiness() {
  const sources = useDataModeStore((s) => s.sources);
  const summary = readinessSummary();

  return (
    <div style={{ color: tokens.text, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Headline */}
      <div
        style={{
          padding: '10px 14px',
          background: tokens.panelAlt,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <CalciteIcon icon="plug" scale="m" />
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            System complete · awaiting {summary.awaitingCredentials} credential
            {summary.awaitingCredentials === 1 ? '' : 's'}
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            {summary.total} connectors · {summary.liveReady} live-ready ·{' '}
            {summary.total - summary.liveReady - summary.awaitingCredentials} mock-only (contract documented).
            Every source runs on the mock driver today; live is a credential + cutover away.
          </div>
        </div>
      </div>

      {/* Real gateway integration state (read-only, not a simulated rung) */}
      <JnpaApiStatusCard />

      {/* Per-connector cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        {CONNECTORS.map((c) => {
          const meta = SOURCE_BY_ID[c.id];
          const cred = credentialStatus(c);
          const progress = goLiveProgress(c);
          const rung = sources[c.id]?.state ?? 'LIVE';
          return (
            <div
              key={c.id}
              style={{
                border: `1px solid ${tokens.border}`,
                borderRadius: tokens.radius.sm,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700 }}>{meta.label}</span>
                <span style={{ fontSize: 10, color: tokens.textMuted }}>contract v{c.contractVersion}</span>
              </div>

              {/* driver tiers */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(['mock', 'replay', 'live'] as DriverTier[]).map((t) => {
                  const has = c.driversImplemented.includes(t);
                  return (
                    <span
                      key={t}
                      title={has ? `${t} driver implemented` : `${t} driver not yet implemented`}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 3,
                        border: `1px solid ${has ? TIER_COLOR[t] : tokens.border}`,
                        color: has ? TIER_COLOR[t] : tokens.textMuted,
                        opacity: has ? 1 : 0.4,
                      }}
                    >
                      {t.toUpperCase()}
                    </span>
                  );
                })}
                <span style={{ flex: 1 }} />
                <CalciteChip scale="s" kind={cred === 'present' ? 'brand' : 'neutral'} icon={cred === 'present' ? 'check-circle' : 'circle'}>
                  {cred === 'present' ? 'credential present' : 'credential absent'}
                </CalciteChip>
              </div>

              {/* live rung */}
              <div style={{ fontSize: 11, color: tokens.textMuted }}>
                Runtime: <strong style={{ color: tokens.text }}>{rung}</strong> — {rungLabel(rung)}
              </div>

              {/* providers */}
              <div style={{ fontSize: 11 }}>
                <span style={{ color: tokens.textMuted }}>Providers: </span>
                {c.providers.map((p, i) => (
                  <span key={p.name}>
                    {i > 0 && ', '}
                    <span style={{ color: p.probable ? tokens.text : tokens.textMuted, fontWeight: p.probable ? 600 : 400 }}>
                      {p.name}
                    </span>
                    {p.contractStub && <span title="request/response contract stub exists"> ✓</span>}
                  </span>
                ))}
              </div>

              {/* go-live checklist */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                {GO_LIVE_STEPS.map((step) => {
                  const done = progress[step.key];
                  return (
                    <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                      <CalciteIcon
                        icon={done ? 'check-circle-f' : 'circle'}
                        scale="s"
                        style={{ color: done ? tokens.good : tokens.textMuted }}
                      />
                      <span style={{ color: done ? tokens.text : tokens.textMuted }}>{step.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
