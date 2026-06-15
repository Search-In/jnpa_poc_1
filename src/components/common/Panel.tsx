/**
 * Reusable titled panel + standard empty/error/loading states so no widget ever
 * renders a blank box (quality-bar rule). Pure presentational.
 */

import type { ReactNode } from 'react';
import { CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { tokens } from '@/theme/tokens';

export function Panel({
  title,
  actions,
  children,
  minHeight = 120,
  height,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  minHeight?: number;
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
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: tokens.text, letterSpacing: 0.3 }}>
          {title}
        </h2>
        {actions}
      </div>
      <div style={{ flex: 1, padding: 12, minHeight: 0 }}>{children}</div>
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

export function PanelError({ message }: { message: string }) {
  return (
    <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
      <div slot="title">Couldn’t load</div>
      <div slot="message">{message}</div>
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
