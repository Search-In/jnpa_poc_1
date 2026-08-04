/**
 * Vessels ▸ Track by Container — NLDS Logistics Data Bank–style container track UI.
 *
 * Same guest auth as https://ldb.co.in/ldb/searate/… :
 *   mobile OTP → searateToken → track any container until JWT expires.
 *
 * Layout: OTP login → search → summary → Routes | Vessel | Demurrage + map.
 */

import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import {
  CalciteButton,
  CalciteInput,
  CalciteLabel,
  CalciteNotice,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import { Panel, PanelLoading, TechnicalDetails } from '@/components/common/Panel';
import { ldbFallbackMessage } from '@/data/ldb/failure';
import { ContainerTrackMap } from '@/components/marine/ContainerTrackMap';
import { env } from '@/data/config';
import {
  LdbAuthRequiredError,
  trackContainerById,
} from '@/data/ldb/track';
import {
  clearSearateToken,
  generateSearateOtp,
  hasSearateSession,
  mobileNoFromToken,
  verifySearateOtp,
} from '@/data/ldb/token';
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

const formBarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'flex-start',
  padding: '10px 12px',
  background: tokens.panelAlt,
  border: `1px solid ${tokens.border}`,
  borderRadius: tokens.radius.sm,
};

export function ContainerTrackPanel() {
  const [containerNo, setContainerNo] = useState('CCLU7468361');
  const [mobileNo, setMobileNo] = useState(env.ldb.mobileNo);
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [sessionMobile, setSessionMobile] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [track, setTrack] = useState<ContainerTrackResult | null>(null);
  const [sideTab, setSideTab] = useState<SideTab>('routes');

  function syncSession() {
    const ok = hasSearateSession();
    setAuthed(ok);
    setSessionMobile(ok ? mobileNoFromToken() : null);
    if (ok) {
      const fromJwt = mobileNoFromToken();
      if (fromJwt) setMobileNo(fromJwt);
    }
  }

  useEffect(() => {
    syncSession();
  }, []);

  function requireReauth(message: string) {
    clearSearateToken();
    setAuthed(false);
    setSessionMobile(null);
    setOtpSent(false);
    setOtp('');
    setTrack(null);
    setError(message);
  }

  async function onSendOtp(e?: FormEvent) {
    e?.preventDefault();
    setAuthBusy(true);
    setError(null);
    setAuthMessage(null);
    try {
      await generateSearateOtp(mobileNo);
      setOtpSent(true);
      setAuthMessage(`Code sent to ${mobileNo.trim()}. Enter it below to continue.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function onVerifyOtp(e?: FormEvent) {
    e?.preventDefault();
    setAuthBusy(true);
    setError(null);
    setAuthMessage(null);
    try {
      await verifySearateOtp(mobileNo, otp);
      syncSession();
      setOtp('');
      setOtpSent(false);
      setAuthMessage('You’re signed in. Enter a container number to track it.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }

  function onSignOut() {
    clearSearateToken();
    setAuthed(false);
    setSessionMobile(null);
    setOtpSent(false);
    setOtp('');
    setTrack(null);
    setAuthMessage(null);
    setError(null);
  }

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
      if (err instanceof LdbAuthRequiredError) {
        requireReauth(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel title="Track by container" height={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
        {!authed ? (
          <form onSubmit={otpSent ? onVerifyOtp : onSendOtp} style={formBarStyle}>
            <CalciteLabel scale="s" style={{ flex: '0 1 180px', margin: 0, color: tokens.text }}>
              Mobile number
              <CalciteInput
                scale="m"
                value={mobileNo}
                placeholder="10-digit mobile"
                maxLength={10}
                onCalciteInputInput={(ev) => setMobileNo(ev.target.value ?? '')}
              />
            </CalciteLabel>
            {otpSent && (
              <CalciteLabel scale="s" style={{ flex: '0 1 140px', margin: 0, color: tokens.text }}>
                Verification code
                <CalciteInput
                  scale="m"
                  value={otp}
                  placeholder="6-digit code"
                  maxLength={6}
                  onCalciteInputInput={(ev) => setOtp(ev.target.value ?? '')}
                />
              </CalciteLabel>
            )}
            <CalciteLabel scale="s" style={{ flex: '0 0 auto', margin: 0, color: tokens.text }}>
              <span aria-hidden style={{ visibility: 'hidden' }}>
                Auth
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {!otpSent ? (
                  <CalciteButton type="submit" iconStart="mobile" scale="m" loading={authBusy || undefined}>
                    Send code
                  </CalciteButton>
                ) : (
                  <>
                    <CalciteButton type="submit" iconStart="check" scale="m" loading={authBusy || undefined}>
                      Verify
                    </CalciteButton>
                    <CalciteButton
                      type="button"
                      appearance="outline"
                      scale="m"
                      disabled={authBusy || undefined}
                      onClick={() => {
                        setOtpSent(false);
                        setOtp('');
                        setAuthMessage(null);
                      }}
                    >
                      Change number
                    </CalciteButton>
                  </>
                )}
              </div>
            </CalciteLabel>
          </form>
        ) : (
          <form onSubmit={onSearch} style={formBarStyle}>
            <CalciteLabel scale="s" style={{ flex: '1 1 220px', margin: 0, color: tokens.text }}>
              Container No.
              <CalciteInput
                scale="m"
                value={containerNo}
                placeholder="Enter Container No."
                onCalciteInputInput={(ev) => setContainerNo(ev.target.value ?? '')}
              />
            </CalciteLabel>
            <CalciteLabel scale="s" style={{ flex: '0 0 auto', margin: 0, color: tokens.text }}>
              <span aria-hidden style={{ visibility: 'hidden' }}>
                Track
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <CalciteButton type="submit" iconStart="search" scale="m" loading={loading || undefined}>
                  Track
                </CalciteButton>
                <CalciteButton type="button" appearance="outline" scale="m" onClick={onSignOut}>
                  Sign out
                </CalciteButton>
              </div>
            </CalciteLabel>
            {sessionMobile && (
              <div
                style={{
                  flex: '1 1 100%',
                  fontSize: 11,
                  color: tokens.textMuted,
                  marginTop: -4,
                }}
              >
                Signed in as {sessionMobile}
              </div>
            )}
          </form>
        )}

        {authMessage && !error && (
          <CalciteNotice open kind="success" icon="check-circle" scale="s">
            <div slot="message">{authMessage}</div>
          </CalciteNotice>
        )}

        {/* NOT routed through the shared PanelError, deliberately. That helper
            translates raw connector strings ("[UC3] … HTTP 500 …") into operator
            language, but this panel's connector already emits operator language
            at the source (see track.ts / token.ts) — and this notice additionally
            distinguishes "you are not signed in" from "the lookup failed", which
            PanelError has no way to know. */}
        {error && (
          <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">{authed ? 'Couldn’t track' : 'Sign in needed'}</div>
            <div slot="message">{error}</div>
          </CalciteNotice>
        )}

        {loading && !track && <PanelLoading label="Looking up container…" />}

        {!loading && !track && !error && authed && (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="message">
              Enter a container number (4 letters + 7 digits) to see its journey.
            </div>
          </CalciteNotice>
        )}

        {!authed && !error && !authMessage && (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="message">
              Enter your mobile number to receive a one-time code, then track any container.
            </div>
          </CalciteNotice>
        )}

        {track && (
          <>
            {/* The sample-fallback state, stated where it cannot be missed.
                It replaces a 10px amber caption inside SummaryBar that was
                effectively invisible on a projector — and, more importantly, said
                only THAT the sample was used, never why. With the fallback on by
                default, a rejected token and a switched-off integration otherwise
                render as the same successful-looking demo track. */}
            {track.fromSample && (
              <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
                <div slot="title">Showing bundled sample data — not live LDB</div>
                <div slot="message">
                  {ldbFallbackMessage(track.sampleReason ?? 'error')} This is the bundled
                  CCLU7468361 demo track, not a live NLDS record.
                  {track.sampleDetail && <TechnicalDetails detail={track.sampleDetail} />}
                </div>
              </CalciteNotice>
            )}
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
          {/* No "Demo data" caption here any more: the sample state is stated in
              full — with the REASON it fired — in the notice above the card. A
              10px caption inside the summary bar is invisible on a projector, and
              two signals for one state is one too many. */}
          <div style={{ fontSize: 12, color: tokens.textMuted }}>⚓ {track.carrierName}</div>
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
