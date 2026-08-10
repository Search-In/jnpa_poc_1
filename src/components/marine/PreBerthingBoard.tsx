/**
 * <PreBerthingBoard> — the Pre-Berthing Status Board (spec screen M-08, UI-040).
 *
 * For a target berthing ("alongside by 02:35"), everything that must be true and
 * by when. Computed BACKWARD from the target using each precondition's lead time —
 * latest-satisfiable = target − cumulative downstream lead — not forward by
 * simulation: this is the screen marine staff actually use.
 *
 * Data reactivity: the target list is the REAL upcoming calls (ledger-derived
 * vessel states, inbound/expected), preconditions are evaluated against the REAL
 * berth states, pilotage records, tug register and corpus tide readings. Where the
 * corpus cannot answer (e.g. customs clearance records are not in the UC-1 slice)
 * the row says NOT EVALUATED — never a fabricated green lamp.
 *
 * Lead times come from src/config/targets.ts (standard pilotage/clearance leads),
 * the same constants the planner uses — one vocabulary across screens.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchMarineBerths,
  fetchMarineVesselStates,
  fetchTides,
  type MarineVesselState,
} from '@/data/uc3/marineDashboard';
import { fetchPortCraft } from '@/data/uc3/portCraft';
import { nearestTide } from '@/data/Uc3Adapter';
import { getAsOfDate, getAsOfEpoch, subscribeAsOfDate } from '@/data/asOfDate';
import { STANDARD_CLEARANCE_H, STANDARD_PILOTAGE_LEAD_H } from '@/config/targets';
import { Panel, PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

const H = 3_600_000;
const TUGS_PER_MOVE = 2;

type LampState = 'ok' | 'at-risk' | 'missing' | 'not-evaluated';

interface Precondition {
  item: string;
  owner: string;
  leadH: number;
  state: LampState;
  detail: string;
  /** Latest moment this can still be satisfied (epoch ms). */
  latestBy: number;
}

const LAMP: Record<LampState, { bg: string; label: string }> = {
  ok: { bg: tokens.good, label: 'ready' },
  'at-risk': { bg: tokens.warn, label: 'at risk' },
  missing: { bg: tokens.bad, label: 'missing' },
  'not-evaluated': { bg: tokens.offline, label: 'not evaluated' },
};

export function PreBerthingBoard() {
  // Header date-pin (UC1-004): re-anchors the target list + berth/pilot state
  // to the picked corpus day instead of the backend's live "now".
  const asOfDate = useSyncExternalStore(subscribeAsOfDate, getAsOfDate, getAsOfDate);
  const asOfEpoch = getAsOfEpoch();
  const berths = useAdapterQuery(() => fetchMarineBerths(asOfEpoch || undefined), [asOfDate]);
  const states = useAdapterQuery(() => fetchMarineVesselStates(asOfEpoch || undefined), [asOfDate]);
  const tides = useAdapterQuery(() => fetchTides(), []);
  const craft = useAdapterQuery(() => fetchPortCraft(), []);
  const [selected, setSelected] = useState<string>('');

  const anchor = berths.data?.asOf ?? 0;

  const targets = useMemo(() => {
    const items = states.data?.items ?? [];
    return items
      .filter((s) => (s.state === 'inbound' || s.state === 'expected' || s.state === 'at_anchorage'))
      .map((s) => ({ ...s, targetTs: s.etb || s.eta }))
      .filter((s) => s.targetTs > 0)
      .sort((a, b) => a.targetTs - b.targetTs)
      .slice(0, 25);
  }, [states.data]);

  const chosen = useMemo(
    () => targets.find((t) => key(t) === selected) ?? targets[0] ?? null,
    [targets, selected],
  );

  const preconditions = useMemo<Precondition[]>(() => {
    if (!chosen) return [];
    const target = chosen.targetTs;
    const out: Precondition[] = [];
    const flag = (latestBy: number, satisfied: boolean | null): LampState =>
      satisfied === null ? 'not-evaluated'
        : satisfied ? 'ok'
        : latestBy - anchor <= H ? 'missing' : 'at-risk';

    // 1. Berth allotted — everything downstream chains from the berth.
    const berthKnown = chosen.berthCode !== '';
    const berthFree = berthKnown
      ? berths.data?.items.find((b) => b.code === chosen.berthCode)?.state === 'free'
      : null;
    const berthLatest = target - STANDARD_PILOTAGE_LEAD_H * H;
    out.push({
      item: 'Berth allotted & clear',
      owner: 'Marine planner',
      leadH: STANDARD_PILOTAGE_LEAD_H,
      latestBy: berthLatest,
      state: !berthKnown ? flag(berthLatest, false) : flag(berthLatest, berthFree),
      detail: !berthKnown
        ? 'No berth allotted in the ledger yet (BERALT outstanding)'
        : berthFree === null
          ? `Berth ${chosen.berthCode} not in the container-berth register`
          : berthFree
            ? `Berth ${chosen.berthCode} is clear`
            : `Berth ${chosen.berthCode} still occupied — departure of the incumbent must precede this call`,
    });

    // 2. Pilot boarding — statutory lead before the alongside instant.
    const pilotKnown = chosen.pilotBoardedAt > 0;
    const pilotLatest = target - STANDARD_PILOTAGE_LEAD_H * H;
    out.push({
      item: 'Pilot assigned & boarded',
      owner: 'Pilotage',
      leadH: STANDARD_PILOTAGE_LEAD_H,
      latestBy: pilotLatest,
      state: flag(pilotLatest, pilotKnown ? true : null),
      detail: pilotKnown
        ? `Pilot boarded ${istDateTime(chosen.pilotBoardedAt)} (pilot card)`
        : 'No pilot-card record yet — assignment not visible in this corpus slice',
    });

    // 3. Tug availability — typed resources, never an integer count (UI-037).
    const tugs = (craft.data ?? []).filter((c) => /tug/i.test(c.craftType));
    const tugLatest = target - 1 * H;
    out.push({
      item: `Tugs available (${TUGS_PER_MOVE} required)`,
      owner: 'Marine ops',
      leadH: 1,
      latestBy: tugLatest,
      state: flag(tugLatest, tugs.length >= TUGS_PER_MOVE),
      detail: `${tugs.length} tugs in the register` +
        (tugs.length
          ? ` (max bollard pull ${Math.max(...tugs.map((t) => t.bollardPullT ?? 0))} t)`
          : ''),
    });

    // 4. Clearances — pratique/immigration/entry-inwards records are not in the
    //    UC-1 corpus slice; saying so beats a fabricated green lamp (UI-027).
    out.push({
      item: 'Clearances (pratique · immigration · entry inwards)',
      owner: 'Agencies',
      leadH: STANDARD_CLEARANCE_H,
      latestBy: target - STANDARD_CLEARANCE_H * H,
      state: 'not-evaluated',
      detail: 'Clearance records are not part of the shared UC-1 corpus — not evaluated, not assumed',
    });

    // 5. Tidal water level at the target instant, from the REAL tide panels.
    const tide = nearestTide(tides.data?.items ?? [], target);
    const tideLatest = target;
    out.push({
      item: 'Tidal water level at target',
      owner: 'Duty officer',
      leadH: 0,
      latestBy: tideLatest,
      state: tide === null ? 'not-evaluated' : tide.heightM >= 2.0 ? 'ok' : 'at-risk',
      detail: tide === null
        ? 'No tide reading covers the target instant'
        : `${tide.heightM.toFixed(2)} m above chart datum at ${istDateTime(tide.tideTs)} ` +
          `(${tide.sourceTerminal} berthing-report tide table)` +
          (tide.heightM < 2.0 ? ' — deep-draught movement needs the DUKC window check' : ''),
    });

    return out.sort((a, b) => a.latestBy - b.latestBy);
  }, [chosen, anchor, berths.data, craft.data, tides.data]);

  if (states.loading || berths.loading) return <PanelLoading label="Loading pre-berthing status…" />;
  if (states.error) return <PanelError message={states.error} />;
  if (targets.length === 0) {
    return <PanelEmpty message="No upcoming calls (inbound / expected / at anchorage) in the current window." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Target call" minHeight={64}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <label htmlFor="preberth-target" style={{ color: tokens.textMuted }}>
            Alongside target:
          </label>
          <select
            id="preberth-target"
            value={chosen ? key(chosen) : ''}
            onChange={(e) => setSelected(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12, maxWidth: 420 }}
          >
            {targets.map((t) => (
              <option key={key(t)} value={key(t)}>
                {t.vesselName || `IMO ${t.imoNo}`} — {istDateTime(t.targetTs)}
                {t.berthCode ? ` @ ${t.berthCode}` : ' (berth TBA)'}
              </option>
            ))}
          </select>
          {chosen && (
            <span style={{ color: tokens.textMuted }}>
              state: {chosen.state.replace('_', ' ')} · source: operational ledger
            </span>
          )}
        </div>
      </Panel>

      <Panel title="Preconditions — computed backward from the target" minHeight={220}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '14px 1.6fr 0.8fr 0.5fr 1fr 1.8fr',
              gap: 8,
              color: tokens.textMuted,
              padding: '0 8px',
            }}
          >
            <span />
            <span>Item</span>
            <span>Owner</span>
            <span>Lead</span>
            <span>Latest satisfiable</span>
            <span>Status</span>
          </div>
          {preconditions.map((p) => {
            const urgent = p.state !== 'ok' && p.state !== 'not-evaluated' && p.latestBy - anchor <= H;
            return (
              <div
                key={p.item}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '14px 1.6fr 0.8fr 0.5fr 1fr 1.8fr',
                  gap: 8,
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: `1px solid ${urgent ? tokens.bad : tokens.border}`,
                  background: urgent ? '#fdecea' : tokens.panel,
                }}
              >
                <span
                  title={LAMP[p.state].label}
                  style={{
                    width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                    background: LAMP[p.state].bg,
                  }}
                />
                <span style={{ fontWeight: 600 }}>{p.item}</span>
                <span>{p.owner}</span>
                <span>{p.leadH > 0 ? `${p.leadH} h` : '—'}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{istDateTime(p.latestBy)}</span>
                <span style={{ color: tokens.textMuted }}>{p.detail}</span>
              </div>
            );
          })}
          <div style={{ color: tokens.textMuted, fontSize: 11, marginTop: 4 }}>
            Latest-satisfiable = target − cumulative downstream lead time (backward chaining,
            spec UI-040). Rows inside the next hour are highlighted. NOT EVALUATED means the
            corpus carries no record to judge — never an assumed green.
          </div>
        </div>
      </Panel>
    </div>
  );
}

function key(s: MarineVesselState & { targetTs?: number }): string {
  return `${s.imoNo || s.viaNo || s.vesselName}:${s.voyageNo}`;
}
