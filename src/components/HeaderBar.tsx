/**
 * <HeaderBar> — title, live status, DATA_MODE chip slot, and the single
 * authoritative clock (spec UI-001 / UI-002).
 *
 * When `VITE_UC3_AS_OF` is set the twin is in corpus REPLAY: the clock freezes
 * on that pin and does NOT read the browser wall clock. Live feeds swap in by
 * clearing the pin — no screen logic change.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { env } from '@/data/config';
import { tokens } from '@/theme/tokens';

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istClock(ms: number): string {
  const ist = new Date(ms + IST_OFFSET_MS);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} IST`;
}

function istDateLabel(ms: number): string {
  const ist = new Date(ms + IST_OFFSET_MS);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${dd} ${months[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

export function HeaderBar({ extra }: { extra?: ReactNode }) {
  const connection = useAppStore((s) => s.connection);
  const lastUpdate = useAppStore((s) => s.lastUpdate);
  const pinned = env.uc3.asOfMs > 0;
  const [wallNow, setWallNow] = useState(() => Date.now());

  useEffect(() => {
    if (pinned) return; // authoritative pin — do not tick the browser clock
    const t = setInterval(() => setWallNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pinned]);

  const clockMs = pinned ? env.uc3.asOfMs : wallNow;
  const live = connection === 'connected';
  const agoS = lastUpdate ? Math.max(0, Math.round((wallNow - lastUpdate) / 1000)) : null;
  const dotColor = live ? tokens.live : connection === 'error' ? tokens.bad : tokens.offline;

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 16px',
        background: tokens.panel,
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <strong style={{ fontSize: 16, color: tokens.text }}>
          JNPA · Vessel Traffic Management &amp; Optimisation
        </strong>
        <span style={{ fontSize: 12, color: tokens.textMuted }}>Digital Twin PoC · Use Case 1</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {extra}

        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: dotColor,
              boxShadow: live ? `0 0 0 3px ${tokens.live}33` : 'none',
            }}
          />
          <span style={{ color: tokens.textMuted }}>
            {live
              ? agoS === null
                ? 'connected'
                : `updated ${agoS}s ago`
              : connection}
          </span>
        </span>

        <span
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            lineHeight: 1.2,
          }}
          aria-label={
            pinned
              ? `Authoritative replay clock ${istDateLabel(clockMs)} ${istClock(clockMs)}`
              : 'Current time (IST)'
          }
          title={
            pinned
              ? `VITE_UC3_AS_OF=${env.uc3.asOfIso} — twin replays the richest real week JNPA shared; live feeds swap in without code change.`
              : undefined
          }
        >
          {pinned && (
            <span style={{ fontSize: 10, color: tokens.mode.REPLAY, fontWeight: 700 }}>
              REPLAY · {istDateLabel(clockMs)}
            </span>
          )}
          <span
            style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, color: tokens.text }}
          >
            {istClock(clockMs)}
          </span>
        </span>
      </div>
    </header>
  );
}
