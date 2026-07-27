/**
 * <BathymetryOverview> — the default Bathymetry tab: survey coverage at a glance.
 *
 * Answers the question an operator actually opens this section with: which charts do we
 * hold, and how much of the port do they actually cover with usable depth data?
 *
 * Everything here is derived from the ONE survey-list call the Surveys tab already makes —
 * `soundingCount` is served as a per-row aggregate, so the coverage summary costs no extra
 * request and, critically, never pages through soundings to count them. A survey holds
 * 15k-30k soundings; totals are the gateway's job, not the browser's.
 *
 * A survey listing 0 soundings is NOT an error: it is a registered chart whose PDF has not
 * been uploaded yet, and it is called out as such so the gap is visible rather than
 * looking like a load failure.
 */

import { useMemo } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchBathymetrySurveys } from '@/data/uc3/bathymetry';
import { SourceBadge } from '@/provenance/SourceBadge';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

export interface BathymetryOverviewProps {
  /** Bumped after a successful import so the summary refetches. */
  registerKey?: number;
}

function Stat({ label, value, unit, hint, tone }: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: 'good' | 'warn' | 'muted';
}) {
  const colour = tone === 'good' ? tokens.good
    : tone === 'warn' ? tokens.warn
    : tone === 'muted' ? tokens.textMuted
    : tokens.text;
  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.panel,
        padding: tokens.space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 11, color: tokens.textMuted, letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: colour, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {unit && <span style={{ fontSize: 12, fontWeight: 500, color: tokens.textMuted }}> {unit}</span>}
      </span>
      {hint && <span style={{ fontSize: 11, color: tokens.textMuted }}>{hint}</span>}
    </div>
  );
}

export function BathymetryOverview({ registerKey = 0 }: BathymetryOverviewProps) {
  const q = useAdapterQuery(
    () => fetchBathymetrySurveys({ sort: 'drawing_no', direction: 'asc' }),
    [registerKey],
  );

  const view = useMemo(() => {
    const surveys = q.data ?? [];
    if (!surveys.length) return null;
    const withData = surveys.filter((s) => s.soundingCount > 0);
    const soundings = surveys.reduce((n, s) => n + s.soundingCount, 0);
    const depths = surveys.map((s) => s.designDepthM).filter((d): d is number => d !== null);
    return {
      surveys,
      surveyCount: surveys.length,
      loaded: withData.length,
      pending: surveys.length - withData.length,
      soundings,
      minDesign: depths.length ? Math.min(...depths) : null,
      maxDesign: depths.length ? Math.max(...depths) : null,
      largest: withData.slice().sort((a, b) => b.soundingCount - a.soundingCount)[0] ?? null,
    };
  }, [q.data]);

  if (q.loading && !q.data) return <PanelLoading label="Loading bathymetry coverage…" />;
  if (q.error) return <PanelError message={q.error} />;
  if (!view) {
    return (
      <PanelEmpty message="No bathymetry surveys registered yet. Upload a chart PDF via the Data Upload tab." />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <div>
        <SourceBadge source="BATHY" />
        <p style={{ margin: 0, fontSize: 11.5, color: tokens.textMuted }}>
          Multibeam survey charts ingested through the shared marine upload flow. Depths are
          metres below Chart Datum; a sounding flagged <em>above design</em> is shallower than
          the design depth — a shoal, not a deep spot.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: tokens.space.md }}>
        <Stat label="Surveys registered" value={String(view.surveyCount)} />
        <Stat
          label="Charts with soundings"
          value={String(view.loaded)}
          hint={view.pending ? `${view.pending} awaiting upload` : 'all charts loaded'}
          tone={view.pending ? 'warn' : 'good'}
        />
        <Stat
          label="Soundings stored"
          value={view.soundings.toLocaleString()}
          tone={view.soundings ? undefined : 'muted'}
        />
        <Stat
          label="Design depth range"
          value={
            view.minDesign === null
              ? '—'
              : view.minDesign === view.maxDesign
                ? view.minDesign.toFixed(2)
                : `${view.minDesign.toFixed(2)}–${(view.maxDesign ?? 0).toFixed(2)}`
          }
          unit={view.minDesign === null ? undefined : 'm'}
          hint="below Chart Datum"
        />
      </div>

      {view.pending > 0 && (
        <div
          style={{
            border: `1px solid ${tokens.warn}`,
            borderRadius: tokens.radius.md,
            background: `${tokens.warn}14`,
            padding: tokens.space.md,
            fontSize: 12,
            color: tokens.text,
          }}
        >
          <strong>{view.pending}</strong> registered survey{view.pending === 1 ? '' : 's'} carry
          no soundings yet — the chart PDF has not been uploaded. Use the Data Upload tab; the
          survey must already be registered for its soundings to attach.
        </div>
      )}

      {view.largest && (
        <div style={{ fontSize: 11.5, color: tokens.textMuted }}>
          Largest chart: <span style={{ color: tokens.text }}>{view.largest.drawingNo}</span>
          {' — '}
          {view.largest.soundingCount.toLocaleString()} soundings.
        </div>
      )}
    </div>
  );
}
