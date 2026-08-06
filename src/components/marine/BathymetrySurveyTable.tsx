/**
 * <BathymetrySurveyTable> — the Bathymetry ▸ Surveys register, for Marine Ops.
 *
 * Framed around the three questions an operator actually opens this on:
 *
 *   1. Do we hold a survey for this stretch of channel?      -> Status
 *   2. Is any of it shallower than design depth?             -> Above Design
 *   3. How much evidence is behind that?                     -> Soundings
 *
 * so the columns are the operational answer, not a dump of `core.bathymetry_survey`.
 * `survey_start` / `survey_end` / `file_path` / `survey_vessel` are deliberately NOT
 * columns: they are provenance, not decisions, and the vessel is the same on every
 * chart in the corpus. Vessel and dates remain available through the API.
 *
 * ABOVE-DESIGN COST, stated plainly. `above_design_count` is served by
 * `/surveys/{id}/stats`, NOT by the survey list, and the API contract is fixed — so this
 * composes the two client-side: one list call, then one stats call per survey that
 * actually HAS soundings. That is bounded (the corpus is ~12 charts, and unimported ones
 * are skipped) but it is an N+1. The clean fix is to add the column to the list endpoint;
 * until then a failed stats call degrades that ONE row to "—" rather than failing the
 * table.
 *
 * Filtering is client-side because the whole register is ~12 rows and already loaded:
 * that makes search instant, lets one box match Drawing No OR Section (the API exposes
 * them as separate params), and avoids a request per keystroke.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchBathymetrySurveys,
  fetchBathymetrySurveyStats,
} from '@/data/uc3/bathymetry';
import type { BathymetrySurvey, BathymetrySurveyStats } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import {
  STATUS_COLOR, STATUS_HINT, STATUS_LABEL, STATUS_ORDER, surveyStatus,
  type SurveyStatus,
} from '@/components/marine/bathymetrySurveyStatus';
import { tokens } from '@/theme/tokens';

/* ----------------------------------------------------------------- row model */

export interface SurveyRow extends BathymetrySurvey {
  stats: BathymetrySurveyStats | null;
  /** Null when the survey has soundings but its stats call failed. */
  aboveDesign: number | null;
  status: SurveyStatus;
  /** False when the chart carried no grid — the soundings cannot be mapped. */
  mappable: boolean;
}

/* ----------------------------------------------------------------- styles */

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  background: tokens.panelAlt, whiteSpace: 'nowrap', position: 'sticky', top: 0,
};
const TD: CSSProperties = {
  fontSize: 12.5, lineHeight: 1.4, color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};
const NUM: CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const SELECT: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

function StatusChip({ status }: { status: SurveyStatus }) {
  const colour = STATUS_COLOR[status];
  return (
    <span
      title={STATUS_HINT[status]}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', fontSize: 11, lineHeight: 1.5,
        borderRadius: tokens.radius.sm, background: tokens.panelAlt,
        border: `1px solid ${colour}66`, color: tokens.text, whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: colour }} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ----------------------------------------------------------------- data */

/**
 * Survey register + the above-design figure. Stats are fetched ONLY for surveys that have
 * soundings — an unimported chart has nothing to aggregate — and a per-survey failure is
 * swallowed to null so one bad row cannot blank the table.
 */
async function fetchSurveyRows(): Promise<SurveyRow[]> {
  const surveys = await fetchBathymetrySurveys({ sort: 'drawing_no', direction: 'asc' });
  const stats = await Promise.all(
    surveys.map((s) =>
      s.soundingCount > 0
        ? fetchBathymetrySurveyStats(s.surveyId).catch(() => null)
        : Promise.resolve(null),
    ),
  );
  return surveys.map((s, i) => {
    const st = stats[i];
    const aboveDesign = s.soundingCount > 0 ? (st ? st.aboveDesignCount : null) : 0;
    return {
      ...s,
      stats: st,
      aboveDesign,
      status: surveyStatus(s.soundingCount, aboveDesign),
      mappable: (st?.georeferencedCount ?? 0) > 0,
    };
  });
}

function pct(part: number, whole: number): string {
  if (!whole) return '';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/* ----------------------------------------------------------------- component */

export function BathymetrySurveyTable() {
  // ONE search box covering Drawing No + Section, replacing the two overlapping
  // free-text inputs. Section and Status are pickers, not more free text.
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('');
  const [status, setStatus] = useState<'' | SurveyStatus>('');

  const q = useAdapterQuery(fetchSurveyRows, []);
  const all = useMemo(() => q.data ?? [], [q.data]);

  const sections = useMemo(
    () => Array.from(new Set(all.map((s) => s.sectionLabel).filter(Boolean))).sort(),
    [all],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all
      .filter((s) => {
        if (needle
          && !s.drawingNo.toLowerCase().includes(needle)
          && !s.sectionLabel.toLowerCase().includes(needle)) return false;
        if (section && s.sectionLabel !== section) return false;
        if (status && s.status !== status) return false;
        return true;
      })
      // Hazards first: a shoal is the reason an operator opens this screen.
      .sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
        || a.drawingNo.localeCompare(b.drawingNo, undefined, { numeric: true }));
  }, [all, search, section, status]);

  const shoalCount = useMemo(() => all.filter((s) => s.status === 'shoal').length, [all]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search drawing no or section…"
          value={search}
          style={{ maxWidth: 280 }}
          onCalciteInputChange={(e) => setSearch((e.target as unknown as { value: string }).value)}
        />
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          style={SELECT}
          aria-label="Filter by section"
        >
          <option value="">All sections</option>
          {sections.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | SurveyStatus)}
          style={SELECT}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>

        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.space.md }}>
          {shoalCount > 0 && (
            <span style={{ fontSize: 12, color: tokens.bad, fontWeight: 600 }}>
              {shoalCount} with shoal
            </span>
          )}
          <span style={{ fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
            {rows.length} of {all.length} survey{all.length === 1 ? '' : 's'}
          </span>
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading bathymetry surveys…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : all.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No bathymetry surveys yet. Upload a chart PDF via the Data Upload tab." />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No survey matches these filters." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Drawing No</th>
                <th style={TH}>Section / Area</th>
                <th style={{ ...TH, textAlign: 'right' }}>Design Depth</th>
                <th style={{ ...TH, textAlign: 'right' }}>Soundings</th>
                <th style={{ ...TH, textAlign: 'right' }}>Above Design</th>
                <th style={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.surveyId}>
                  <td style={{ ...TD, fontWeight: 600, whiteSpace: 'normal', maxWidth: 300 }}>
                    {s.drawingNo || '—'}
                    {s.soundingCount > 0 && !s.mappable && (
                      <span
                        title="This chart carried no coordinate grid — its soundings cannot be plotted on the map"
                        style={{ marginLeft: 6, fontSize: 10, color: tokens.warn }}
                      >
                        no grid
                      </span>
                    )}
                  </td>
                  <td style={TD}>{s.sectionLabel || '—'}</td>
                  <td style={NUM}>
                    {s.designDepthM === null
                      ? <span style={{ color: tokens.textMuted }}>—</span>
                      : `${s.designDepthM.toFixed(2)} m`}
                  </td>
                  <td style={{ ...NUM, color: s.soundingCount ? tokens.text : tokens.textMuted }}>
                    {s.soundingCount ? s.soundingCount.toLocaleString() : '0'}
                  </td>
                  <td style={NUM}>
                    {s.aboveDesign === null ? (
                      <span style={{ color: tokens.textMuted }} title="Stats unavailable for this survey">—</span>
                    ) : s.aboveDesign > 0 ? (
                      <span style={{ color: tokens.bad, fontWeight: 600 }}>
                        {s.aboveDesign.toLocaleString()}
                        <span style={{ color: tokens.textMuted, fontWeight: 400, fontSize: 11 }}>
                          {' '}({pct(s.aboveDesign, s.soundingCount)})
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: tokens.textMuted }}>0</span>
                    )}
                  </td>
                  <td style={TD}><StatusChip status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
