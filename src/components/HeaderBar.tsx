/**
 * <HeaderBar> — title, live status dot + "updated Ns ago", IST clock.
 * Reads connection + lastUpdate from the store; no direct data access.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { tokens } from '@/theme/tokens';

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istClock(now: number): string {
  // Format the UTC+5:30 wall-clock without pulling in a date lib.
  const ist = new Date(now + IST_OFFSET_MS);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} IST`;
}

export function HeaderBar({ extra }: { extra?: ReactNode }) {
  const connection = useAppStore((s) => s.connection);
  const lastUpdate = useAppStore((s) => s.lastUpdate);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const live = connection === 'connected';
  const agoS = lastUpdate ? Math.max(0, Math.round((now - lastUpdate) / 1000)) : null;
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
        {/* Global DATA_MODE provenance chip (passed in by the shell). */}
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
          style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13, color: tokens.text }}
          aria-label="Current time (IST)"
        >
          {istClock(now)}
        </span>
      </div>
    </header>
  );
}
