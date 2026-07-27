/**
 * <ArrivalTimesPanel> — the six-arrival-times ladder for one vessel call
 * (spec UI-025, screen M-02).
 *
 * A labelled row for each arrival-time definition — proforma ETA, declared ETA,
 * last-reported ETA, arrival at anchorage, pilot boarding, first line ashore —
 * each carrying its NAMED SOURCE. The six are stored and rendered independently:
 * the commonest port reporting dispute is which of these the clock started on, so
 * a KPI can name its basis and this panel can prove it.
 *
 * Honesty rules straight from the spec:
 *   - a definition with no source in the ingested corpus renders its explanation,
 *     never a fabricated value;
 *   - a DERIVED value (first line ≈ alongside instant) is visibly badged;
 *   - values come from `/api/marine/calls/{id}/arrival-times`, which assembles the
 *     ladder across the PCS messages, pilot cards and terminal berthing reports.
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchArrivalTimes } from '@/data/uc3/marineDashboard';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

export function ArrivalTimesPanel({ callId }: { callId: number | null }) {
  const { data, loading, error } = useAdapterQuery(
    () => (callId === null ? Promise.resolve(null) : fetchArrivalTimes(callId)),
    [callId],
  );

  if (callId === null) return <PanelEmpty message="Select a call to see its six arrival times." />;
  if (loading) return <PanelLoading label="Loading arrival times…" />;
  if (error) return <PanelError message={error} />;
  if (!data) return <PanelEmpty />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
      <div style={{ color: tokens.textMuted, marginBottom: 2 }}>
        Six arrival-time definitions, each named to its source — a KPI that consumes an
        arrival time states which of these it uses.
      </div>
      {data.rows.map((row) => (
        <div
          key={row.key}
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 1fr',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 6,
            background: row.value > 0 ? tokens.panelAlt : 'transparent',
            border: `1px solid ${tokens.border}`,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {row.label}
            {row.derived && (
              <span
                title="Derived (≈ alongside instant), not directly recorded"
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#fdf3e3',
                  color: tokens.warn,
                }}
              >
                derived
              </span>
            )}
          </div>
          <div>
            {row.value > 0 ? (
              <>
                <div style={{ fontVariantNumeric: 'tabular-nums' }}>{istDateTime(row.value)}</div>
                <div style={{ color: tokens.textMuted, fontSize: 11 }}>{row.source}</div>
                {row.note && (
                  <div style={{ color: tokens.textMuted, fontSize: 11 }}>{row.note}</div>
                )}
              </>
            ) : (
              <div style={{ color: tokens.textMuted, fontStyle: 'italic' }}>
                {row.note || 'no source in ingested corpus'}
              </div>
            )}
          </div>
        </div>
      ))}
      {(data.ata > 0 || data.atd > 0) && (
        <div style={{ color: tokens.textMuted, fontSize: 11, marginTop: 4 }}>
          Call actuals: {data.ata > 0 ? `ATA ${istDateTime(data.ata)}` : 'ATA —'}
          {' · '}
          {data.atc > 0 ? `ops complete ${istDateTime(data.atc)}` : 'ops complete —'}
          {' · '}
          {data.atd > 0 ? `ATD ${istDateTime(data.atd)}` : 'ATD —'}
        </div>
      )}
    </div>
  );
}
