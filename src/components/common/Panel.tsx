/**
 * Reusable titled panel + standard empty/error/loading states so no widget ever
 * renders a blank box (quality-bar rule). Pure presentational.
 */

import type { ReactNode } from 'react';
import { CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { tokens } from '@/theme/tokens';
import { friendlyError } from '@/data/friendlyError';

export function Panel({
  title,
  actions,
  children,
  minHeight = 120,
  height,
  hideTitle = false,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  minHeight?: number;
  /**
   * Suppress the visible header bar while keeping `title` as the region's accessible
   * name. For a panel whose enclosing tab already carries the same words — repeating
   * them costs a row of vertical space and reads as a stutter — without making the
   * landmark anonymous to a screen reader.
   */
  hideTitle?: boolean;
  /** Fixed panel height. When set, the body becomes a bounded scroll viewport. */
  height?: number;
}) {
  return (
    <section
      className="app-region"
      aria-label={title}
      style={{
        display: 'flex',
        flexDirection: 'column',
        // A fixed height wins over content so the body can scroll internally;
        // otherwise minHeight is just a floor and the panel grows with content.
        ...(height ? { height } : { minHeight }),
        overflow: 'hidden',
      }}
    >
      {/* `actions` keeps the bar alive even when the heading is suppressed — hiding a
          title must not also hide the panel's controls. */}
      {(!hideTitle || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 12px',
            borderBottom: `1px solid ${tokens.border}`,
            background: tokens.panelAlt,
          }}
        >
          {hideTitle ? <span /> : (
            <h2
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 600,
                color: tokens.text,
                letterSpacing: 0.3,
              }}
            >
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      <div
        style={{
          flex: 1,
          padding: 12,
          minHeight: 0,
          // Fixed-height panels must scroll their body — without this, six-row
          // ladders (and any tall child) clip with no way to reach lower rows.
          ...(height ? { overflowY: 'auto' as const } : null),
        }}
      >
        {children}
      </div>
    </section>
  );
}

export function PanelLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 80 }}>
      <CalciteLoader label={label} text={label} scale="s" />
    </div>
  );
}

/**
 * The raw technical string, demoted to a collapsed disclosure.
 *
 * A native `<details>` rather than a Calcite accordion: it needs no state,
 * renders reliably inside a `CalciteNotice`'s slotted light DOM, and is
 * keyboard- and screen-reader-accessible for free. Exported because the LDB
 * fallback notice reuses it.
 */
export function TechnicalDetails({ detail }: { detail: string }) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: tokens.textMuted }}>
        Technical details
      </summary>
      <code
        style={{
          display: 'block',
          marginTop: 4,
          fontSize: 11,
          color: tokens.textMuted,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {detail}
      </code>
    </details>
  );
}

/**
 * Standard error state. Takes the RAW message a panel captured and renders the
 * operator-language translation of it (see src/data/friendlyError.ts), keeping
 * the original behind a "Technical details" toggle.
 *
 * The `{ message: string }` signature is unchanged on purpose: ~24 call sites
 * pass `q.error` straight through, so the whole plain-language change lands here
 * rather than in every panel.
 */
export function PanelError({ message }: { message: string }) {
  const e = friendlyError(message);
  return (
    <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
      <div slot="title">{e.title}</div>
      <div slot="message">
        {e.action}
        {e.technical && <TechnicalDetails detail={e.detail} />}
      </div>
    </CalciteNotice>
  );
}

export function PanelEmpty({ message = 'No data for the current window.' }: { message?: string }) {
  return (
    <CalciteNotice open kind="info" icon="information" scale="s">
      <div slot="message">{message}</div>
    </CalciteNotice>
  );
}
