/**
 * <ShippingLinesTable> — the shared JNPA carrier registry, shown inside the
 * Vessels ▸ Shipping Lines sub-tab. Reads `/api/shipping-lines/lines` via the UC-3
 * connector and renders the VesselTable table idiom (tokens-styled <table>,
 * PanelEmpty on no rows).
 *
 * This is a reference registry (carrier code + container attribution), populated as a
 * side effect of the advance-list (IAL/EAL) imports — distinct from the live-AIS feed
 * and the vessel-call spine. The roster is small (tens of carriers), so one request
 * fetches it all and a client-side name filter suffices; the backend already orders it
 * busiest-first. Empty until an advance list is uploaded via the Data Upload sub-tab.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchShippingLines } from '@/data/uc3/shippingLines';
import type { ShippingLine } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

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

/** epoch ms → IST string, or '—' when unknown (0). */
function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const COLUMNS: { key: string; label: string; render: (l: ShippingLine) => string; num?: boolean }[] = [
  { key: 'code', label: 'Line Code', render: (l) => l.lineCode || '—' },
  { key: 'name', label: 'Name', render: (l) => l.lineName || '—' },
  { key: 'source', label: 'Source', render: (l) => l.source || '—' },
  { key: 'containers', label: 'Containers', render: (l) => String(l.containerCount), num: true },
  { key: 'first', label: 'First Seen', render: (l) => fmt(l.firstSeen) },
  { key: 'last', label: 'Last Seen', render: (l) => fmt(l.lastSeen) },
];

export function ShippingLinesTable() {
  const [name, setName] = useState('');
  const q = useAdapterQuery(() => fetchShippingLines(), []);

  const all = q.data ?? [];
  const needle = name.trim().toLowerCase();
  const rows = needle
    ? all.filter((l) => l.lineCode.toLowerCase().includes(needle) || l.lineName.toLowerCase().includes(needle))
    : all;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search line code / name…"
          value={name}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => setName((e.target as unknown as { value: string }).value)}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {rows.length} line{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading shipping-line registry…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No shipping lines yet. Upload an advance list (IAL/EAL) via the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={{ ...TH, textAlign: c.num ? 'right' : 'left' }}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.lineCode}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        ...TD,
                        textAlign: col.num ? 'right' : 'left',
                        fontWeight: col.key === 'code' ? 600 : undefined,
                        color: col.key === 'first' || col.key === 'last' ? tokens.textMuted : TD.color,
                        fontVariantNumeric: col.num || col.key === 'first' || col.key === 'last' ? 'tabular-nums' : undefined,
                      }}
                    >
                      {col.render(l)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
