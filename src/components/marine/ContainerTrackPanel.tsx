/**
 * Vessels ▸ Track by Container — NLDS Logistics Data Bank–style container track UI.
 *
 * Layout mirrors https://ldb.co.in/ldb/searate/… :
 *   search → summary (id / type / status / origin–destination timeline) →
 *   Routes | Vessel | Demurrage sidebar + world route map.
 *
 * Data: GET /ldb-proxy/apigateway/track/cntr/?cntrNo=&mobileNo= (see src/data/ldb).
 */

import { useState, type FormEvent, type CSSProperties } from 'react';
import {
  CalciteButton,
  CalciteInput,
  CalciteLabel,
  CalciteNotice,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import { Panel, PanelLoading } from '@/components/common/Panel';
import { ContainerTrackMap } from '@/components/marine/ContainerTrackMap';
import { env } from '@/data/config';
import { trackContainerById } from '@/data/ldb/track';
import type { ContainerTrackResult } from '@/data/ldb/types';
import { tokens } from '@/theme/tokens';

type SideTab = 'routes' | 'vessel' | 'demurrage';

function formatTrackDate(raw: string | null): string {
  if (!raw) return '—';
  // Accept "YYYY-MM-DD HH:mm:ss" or ISO; display like NLDS: "Aug 3, 2026, 01:00"
  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/,
  );
  if (!m) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[Number(m[2]) - 1] ?? m[2];
  return `${mon} ${Number(m[3])}, ${m[1]}, ${m[4]}:${m[5]}`;
}

function place(name: string, country: string): string {
  if (!name || name === '—') return '—';
  return country ? `${name}, ${country}` : name;
}

const badgeBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: tokens.radius.sm,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.4,
};

export function ContainerTrackPanel() {
  const [containerNo, setContainerNo] = useState('CCLU7468361');
  const [mobileNo, setMobileNo] = useState(env.ldb.mobileNo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<ContainerTrackResult | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('routes');

  async function onSearch(e?: FormEvent) {
    e?.preventDefault();
    const no = containerNo.trim().toUpperCase();
    if (!no) {
      setError('Enter a container number');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await trackContainerById(no, mobileNo);
      setTrack(result);
      setSideTab('routes');
    } catch (err) {
      setTrack(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel title="Track by container ID — NLDS / LDB searate" height={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
        <form
          onSubmit={onSearch}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'flex-start',
            padding: '10px 12px',
            background: tokens.panelAlt,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
          }}
        >
          <CalciteLabel scale="s" style={{ flex: '1 1 220px', margin: 0, color: tokens.text }}>
            Container No.
            <CalciteInput
              scale="m"
              value={containerNo}
              placeholder="Enter Container No."
              onCalciteInputInput={(ev) => setContainerNo(ev.target.value ?? '')}
            />
          </CalciteLabel>
          <CalciteLabel scale="s" style={{ flex: '0 1 160px', margin: 0, color: tokens.text }}>
            Mobile (LDB)
            <CalciteInput
              scale="m"
              value={mobileNo}
              placeholder="Optional mobileNo"
              onCalciteInputInput={(ev) => setMobileNo(ev.target.value ?? '')}
            />
          </CalciteLabel>
          {/* Invisible label keeps the button on the same baseline as the inputs. */}
          <CalciteLabel scale="s" style={{ flex: '0 0 auto', margin: 0, color: tokens.text }}>
            <span aria-hidden style={{ visibility: 'hidden' }}>
              Track
            </span>
            <CalciteButton type="submit" iconStart="search" scale="m" width="full" loading={loading || undefined}>
              Track
            </CalciteButton>
          </CalciteLabel>
        </form>

        {error && (
          <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">Track failed</div>
            <div slot="message">{error}</div>
          </CalciteNotice>
        )}

        {loading && !track && <PanelLoading label="Fetching container track…" />}

        {!loading && !track && !error && (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="message">
              Enter a container number to load NLDS-style ocean tracking (LDB{' '}
              <code>/apigateway/track/cntr/</code>
              ). Without a live token the bundled sample for CCLU7468361 is shown.
            </div>
          </CalciteNotice>
        )}

        {track && (
          <>
            <SummaryBar track={track} />
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'grid',
                gridTemplateColumns: 'minmax(240px, 340px) minmax(0, 1fr)',
                gap: 12,
              }}
              className="container-track-split"
            >
              <aside
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  minHeight: 0,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.panel,
                  padding: 10,
                  overflow: 'hidden',
                }}
              >
                <CalciteSegmentedControl
                  width="full"
                  scale="s"
                  value={sideTab}
                  onCalciteSegmentedControlChange={(ev) => {
                    const v = (ev.target as HTMLCalciteSegmentedControlElement).value as SideTab;
                    if (v) setSideTab(v);
                  }}
                >
                  <CalciteSegmentedControlItem value="routes" checked={sideTab === 'routes'}>
                    Routes
                  </CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="vessel" checked={sideTab === 'vessel'}>
                    Vessel
                  </CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="demurrage" checked={sideTab === 'demurrage'}>
                    Demurrage
                  </CalciteSegmentedControlItem>
                </CalciteSegmentedControl>

                <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                  {sideTab === 'routes' && <RoutesTimeline track={track} />}
                  {sideTab === 'vessel' && <VesselDetails track={track} />}
                  {sideTab === 'demurrage' && <DemurrageDetails track={track} />}
                </div>
              </aside>

              <div
                style={{
                  minHeight: 0,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: tokens.radius.sm,
                  overflow: 'hidden',
                  background: tokens.panelAlt,
                }}
              >
                <ContainerTrackMap track={track} />
              </div>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function SummaryBar({ track }: { track: ContainerTrackResult }) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.panel,
        padding: '12px 16px',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          gap: 12,
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.text }}>
            {place(track.originName, track.originCountry)}
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 4 }}>
            ETD {formatTrackDate(track.etd)}
          </div>
        </div>

        <div style={{ textAlign: 'center', minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: tokens.text }}>CT {track.containerNo}</span>
            <span
              style={{
                ...badgeBase,
                background: tokens.panelAlt,
                border: `1px solid ${tokens.good}66`,
                color: tokens.good,
              }}
            >
              {track.sizeType}
            </span>
            <span
              style={{
                ...badgeBase,
                background: tokens.panelAlt,
                border: `1px solid ${tokens.warn}66`,
                color: tokens.warn,
              }}
            >
              {track.status}
            </span>
          </div>
          <div
            aria-hidden
            style={{
              margin: '10px auto 6px',
              height: 2,
              width: '100%',
              maxWidth: 280,
              backgroundImage: `linear-gradient(to right, ${tokens.accent} 40%, ${tokens.border} 40%)`,
              backgroundSize: '10px 2px',
              backgroundRepeat: 'repeat-x',
              position: 'relative',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: -4,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: tokens.accent,
                border: `2px solid ${tokens.panel}`,
                boxSizing: 'border-box',
              }}
            />
            <span
              style={{
                position: 'absolute',
                right: 0,
                top: -4,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: tokens.accentDim,
                border: `2px solid ${tokens.panel}`,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: tokens.textMuted }}>⚓ {track.carrierName}</div>
          {track.fromSample && (
            <div style={{ fontSize: 10, color: tokens.warn, marginTop: 4 }}>Sample / offline fallback</div>
          )}
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.text }}>
            {place(track.destinationName, track.destinationCountry)}
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 4 }}>
            ETA {formatTrackDate(track.eta)}
          </div>
        </div>
      </div>
    </div>
  );
}

function RoutesTimeline({ track }: { track: ContainerTrackResult }) {
  if (track.milestones.length === 0) {
    return <EmptySide message="No route milestones in this response." />;
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: '4px 0 4px 12px', position: 'relative' }}>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 18,
          top: 8,
          bottom: 8,
          width: 2,
          background: tokens.border,
        }}
      />
      {track.milestones.map((m) => (
        <li
          key={m.id}
          style={{
            position: 'relative',
            padding: '0 0 16px 22px',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 2,
              top: 4,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: m.actual ? tokens.accent : tokens.panel,
              border: `2px solid ${m.transportType === 'VESSEL' ? tokens.bad : tokens.accent}`,
              zIndex: 1,
            }}
          />
          <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text }}>{m.title}</div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>{m.description}</div>
          <div style={{ fontSize: 11, color: tokens.accent, marginTop: 2 }}>
            {formatTrackDate(m.date)}
          </div>
        </li>
      ))}
    </ol>
  );
}

function VesselDetails({ track }: { track: ContainerTrackResult }) {
  const v = track.vessel;
  if (!v) return <EmptySide message="No vessel leg in this response." />;
  const rows: Array<[string, string]> = [
    ['Vessel', v.vessel],
    ['Voyage', v.voyage],
    ['Loading', v.loading],
    ['ETD', formatTrackDate(v.etd)],
    ['Discharge', v.discharge],
    ['ETA', formatTrackDate(v.eta)],
  ];
  return (
    <dl style={{ margin: 0, display: 'grid', gap: 10 }}>
      {rows.map(([k, val]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8 }}>
          <dt style={{ fontSize: 11, color: tokens.textMuted, margin: 0 }}>{k}</dt>
          <dd style={{ fontSize: 13, fontWeight: 600, color: tokens.text, margin: 0 }}>{val}</dd>
        </div>
      ))}
    </dl>
  );
}

function DemurrageDetails({ track }: { track: ContainerTrackResult }) {
  return (
    <dl style={{ margin: 0, display: 'grid', gap: 12 }}>
      <div>
        <dt style={{ fontSize: 11, color: tokens.textMuted, margin: 0 }}>Free Days</dt>
        <dd style={{ fontSize: 14, fontWeight: 600, margin: '4px 0 0' }}>{track.demurrage.freeDays}</dd>
      </div>
      <div>
        <dt style={{ fontSize: 11, color: tokens.textMuted, margin: 0 }}>Days in charge</dt>
        <dd style={{ fontSize: 14, fontWeight: 600, margin: '4px 0 0' }}>
          {track.demurrage.daysInCharge}
        </dd>
      </div>
    </dl>
  );
}

function EmptySide({ message }: { message: string }) {
  return <div style={{ fontSize: 12, color: tokens.textMuted, padding: 8 }}>{message}</div>;
}
