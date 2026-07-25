/**
 * <VesselCallTimeline> — the detail pane for a selected vessel call. Reads
 * `/api/marine/calls/{id}/timeline` via the Phase-1 connector and renders the
 * call's key facts plus its actuals (anchored → pilot boarded → all fast → sailed…).
 *
 * The backend permits REPEATED event types at different timestamps (shifting, a
 * second anchoring), so events are shown in chronological order and every row is
 * kept — this component must never collapse duplicates.
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchVesselCallTimeline } from '@/data/uc3/marineCalls';
import type { VesselCall, VesselCallEvent } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10.5, color: tokens.textMuted, letterSpacing: 0.3, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 12.5, color: tokens.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Header({ call }: { call: VesselCall }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 12 }}>
      <Field label="VCN" value={call.vcn || '—'} />
      <Field label="Vessel" value={call.vesselName || '—'} />
      <Field label="VIA" value={call.viaNo || '—'} />
      <Field label="Voyage" value={call.voyageNo || '—'} />
      <Field label="IMO" value={call.imoNo || '—'} />
      <Field label="Status" value={call.status || '—'} />
      <Field label="ETA" value={fmt(call.eta)} />
      <Field label="ATA" value={fmt(call.ata)} />
      <Field label="ATC" value={fmt(call.atc)} />
      <Field label="ATD" value={fmt(call.atd)} />
    </div>
  );
}

function Events({ events }: { events: VesselCallEvent[] }) {
  if (events.length === 0) {
    return <PanelEmpty message="No actuals recorded for this call yet." />;
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((e) => (
        <li
          key={e.eventId}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '6px 8px',
            background: tokens.panelAlt,
            borderRadius: tokens.radius.sm,
            borderLeft: `3px solid ${tokens.accent}`,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: tokens.text, minWidth: 130 }}>{e.eventType || '—'}</span>
          <span style={{ fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>{fmt(e.eventTs)}</span>
        </li>
      ))}
    </ol>
  );
}

export function VesselCallTimeline({ callId }: { callId: number | null }) {
  const q = useAdapterQuery(
    () => (callId === null ? Promise.resolve({ call: null, events: [] }) : fetchVesselCallTimeline(callId)),
    [callId],
  );

  if (callId === null) {
    return <PanelEmpty message="Select a vessel call to see its timeline." />;
  }
  if (q.loading && !q.data) return <PanelLoading label="Loading timeline…" />;
  if (q.error) return <PanelError message={q.error} />;
  const call = q.data?.call ?? null;
  if (!call) return <PanelEmpty message="Call not found." />;

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Header call={call} />
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: tokens.textMuted, margin: '4px 0 8px' }}>
        Actuals ({q.data?.events.length ?? 0})
      </div>
      <Events events={q.data?.events ?? []} />
    </div>
  );
}
