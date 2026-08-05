/**
 * <VesselCallTimeline> — the detail pane for a selected vessel call. Reads
 * `/api/marine/calls/{id}/timeline` via the Phase-1 connector and renders the
 * call's key facts, the derived lifecycle, and its actuals (anchored → pilot boarded →
 * all fast → sailed…).
 *
 * ONE request. The gateway derives the lifecycle from the very call and events this
 * response already carries, so no second round trip and no client-side derivation.
 *
 * The backend permits REPEATED event types at different timestamps (shifting, a
 * second anchoring), so events are shown in chronological order and every row is
 * kept — this component must never collapse duplicates.
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchVesselCallTimeline } from '@/data/uc3/marineCalls';
import type { VesselCall, VesselCallEvent, CallLifecycle } from '@/types/domain';
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

/**
 * Lifecycle block — the DERIVED business state for this call.
 *
 * Every value is produced by the backend Marine Projection Layer and carried in the
 * timeline response itself; nothing here is computed client-side. Rendered with the
 * same <Field> grid as the stored facts above it, so the layout is unchanged.
 *
 * Omitted entirely when the response carries no lifecycle — the stored fields still show,
 * which is exactly what this pane displayed before the lifecycle was wired in.
 */
function Lifecycle({ state }: { state: CallLifecycle }) {
  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: tokens.textMuted, margin: '10px 0 8px' }}>
        Lifecycle
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        <Field label="Arrival" value={state.arrivalState || '—'} />
        <Field label="Berth" value={state.berthState || '—'} />
        <Field label="Pilot" value={state.pilotState || '—'} />
        <Field label="Departure" value={state.departureState || '—'} />
        <Field label="Shipping" value={state.shippingState || '—'} />
        <Field label="Port Craft" value={state.portcraftState || '—'} />
        <Field label="In Port" value={state.isInPort ? 'Yes' : 'No'} />
        <Field label="At Berth" value={state.isAtBerth ? 'Yes' : 'No'} />
        <Field label="Latest Event" value={state.latestEvent || '—'} />
      </div>
    </>
  );
}

function Header({ call, state }: { call: VesselCall; state?: CallLifecycle | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 12 }}>
      <Field label="VCN" value={call.vcn || '—'} />
      <Field label="Vessel" value={call.vesselName || '—'} />
      <Field label="VIA" value={call.viaNo || '—'} />
      <Field label="Voyage" value={call.voyageNo || '—'} />
      <Field label="IMO" value={call.imoNo || '—'} />
      <Field label="Rotation No" value={call.rotationNo || '—'} />
      <Field label="Terminal" value={call.terminalCode || '—'} />
      <Field label="Berth" value={call.berthCode || '—'} />
      {/* Lifecycle-driven: the engine's status once milestones exist ('At Berth',
          'Departed'), falling back to the stored parser stage when the state endpoint
          did not answer. */}
      <Field label="Status" value={state?.status || call.status || '—'} />
      <Field label="ETA" value={fmt(call.eta)} />
      {/* BERMAN's EDB and rotation number — the berth-application step's own payload,
          previously returned by the API but shown nowhere. */}
      <Field label="ETB" value={fmt(call.etb)} />
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
          {/* Only milestones that happened AT a berth carry one (e.g. BERALT's
              BERTH_ALLOTTED); an anchorage or pilot event legitimately has none, so the
              chip is omitted rather than rendered as an em dash. */}
          {e.berthCode && (
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text, padding: '1px 6px', borderRadius: tokens.radius.sm, background: tokens.panel, border: `1px solid ${tokens.border}` }}>
              {e.berthCode}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export function VesselCallTimeline({ callId }: { callId: number | null }) {
  const q = useAdapterQuery(
    () => (callId === null
      ? Promise.resolve({ call: null, events: [], lifecycle: null })
      : fetchVesselCallTimeline(callId)),
    [callId],
  );

  // Business state arrives in the SAME response — the gateway derives it from the call and
  // events it already loaded, so this pane issues exactly ONE request. Null on a gateway
  // predating the additive `lifecycle` field, in which case the stored fields still render.
  const state = q.data?.lifecycle ?? null;

  if (callId === null) {
    return <PanelEmpty message="Select a vessel call to see its timeline." />;
  }
  if (q.loading && !q.data) return <PanelLoading label="Loading timeline…" />;
  if (q.error) return <PanelError message={q.error} />;
  const call = q.data?.call ?? null;
  if (!call) return <PanelEmpty message="Call not found." />;

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Header call={call} state={state} />
      {state && <Lifecycle state={state} />}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: tokens.textMuted, margin: '10px 0 8px' }}>
        Actuals ({q.data?.events.length ?? 0})
      </div>
      <Events events={q.data?.events ?? []} />
    </div>
  );
}
