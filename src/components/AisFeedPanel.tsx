/**
 * <AisFeedPanel> — the Vessels ▸ AIS Feed surface, split by PROVENANCE.
 *
 * One panel, three tabs, because this application has three genuinely different sources
 * of a vessel position and they must never be presented as one feed:
 *
 *   Live       real MarineTraffic positions from the shared JNPA gateway — the same
 *              connector the map's Live AIS overlay uses, so the two cannot disagree
 *   Derived    UC-3 corpus calls placed by berth / anchorage / channel geometry. Real
 *              vessel identities, synthesised positions — no AIS was involved
 *   Simulated  the offline demo fleet
 *
 * WHY TABS RATHER THAN ONE TABLE WITH A SOURCE COLUMN. The tab is chosen before the rows
 * are read, so the operator cannot mistake which kind of data they are looking at; the
 * previous single table was titled 'Live AIS Feed' while showing derived and simulated
 * hulls, and the per-row SOURCE badge — correct all along — was read second, if at all.
 * Splitting it also lets the live view carry its OWN columns (ship type, destination,
 * flag, fix age) instead of being flattened into the fleet schema.
 *
 * Counts sit on the tab labels, so the split is visible without opening each one.
 */

import { useMemo, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useLiveVesselStore } from '@/map/liveVesselStore';
import { env } from '@/data/config';
import { VesselTable } from './VesselTable';
import { LiveAisTable } from './LiveAisTable';
import { tokens } from '@/theme/tokens';

type FeedTab = 'live' | 'derived' | 'mock';

/** Tone per provenance, matching the map rings and the VesselFeed tags. */
const TAB_COLOR: Record<FeedTab, string> = {
  live: tokens.mode.LIVE,
  derived: tokens.warn,
  mock: tokens.textMuted,
};

export function AisFeedPanel() {
  const vessels = useAppStore((s) => s.vessels);
  // The overlay's own count, so the Live tab label is populated before the tab is opened
  // (its table only polls while mounted). 0 until the overlay or the tab has fetched.
  const liveOverlayCount = useLiveVesselStore((s) => s.count);

  const counts = useMemo(() => {
    const derived = vessels.filter((v) => v.SOURCE === 'derived').length;
    const live = vessels.filter((v) => v.SOURCE === 'live').length;
    return { derived, mock: vessels.length - derived - live };
  }, [vessels]);

  const liveAvailable = env.liveAis.enabled && env.uc3.enabled;

  // Open on whichever tab actually holds something, so the panel never greets the
  // operator with an empty table while a populated one sits unselected.
  const [tab, setTab] = useState<FeedTab>(() =>
    liveAvailable ? 'live' : counts.derived > 0 ? 'derived' : 'mock',
  );

  const TABS: { id: FeedTab; label: string; count: number | null; hint: string }[] = [
    {
      id: 'live',
      label: 'Live',
      // null = "not counted here": the live feed is fetched on demand, so a 0 before the
      // first poll would read as 'no traffic' when it means 'not asked yet'.
      count: liveAvailable ? (liveOverlayCount || null) : 0,
      hint: liveAvailable
        ? 'Real MarineTraffic positions via the shared JNPA gateway'
        : 'Switched off in this build (VITE_LIVE_AIS_ENABLED)',
    },
    {
      id: 'derived',
      label: 'Derived',
      count: counts.derived,
      hint: 'UC-3 corpus vessels placed by berth / anchorage / channel geometry — no AIS',
    },
    {
      id: 'mock',
      label: 'Simulated',
      count: counts.mock,
      hint: 'The offline demo fleet',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        role="tablist"
        aria-label="AIS feed provenance"
        style={{
          display: 'flex',
          gap: tokens.space.xs,
          paddingBottom: tokens.space.sm,
          flexWrap: 'wrap',
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              title={t.hint}
              onClick={() => setTab(t.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                padding: '5px 10px',
                cursor: 'pointer',
                color: active ? tokens.text : tokens.textMuted,
                background: active ? tokens.panelAlt : 'transparent',
                border: `1px solid ${active ? tokens.border : 'transparent'}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: TAB_COLOR[t.id],
                  flex: '0 0 auto',
                }}
              />
              {t.label}
              {t.count !== null && (
                <span style={{ fontVariantNumeric: 'tabular-nums', color: tokens.textMuted }}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {/* Mounted only while selected: the live table polls the gateway, and an unseen
            tab must not hold a request open. */}
        {tab === 'live' ? <LiveAisTable /> : <VesselTable source={tab} />}
      </div>
    </div>
  );
}
