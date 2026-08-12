/**
 * <InfoPopover> — a small "i" information icon that reveals explanatory text on click.
 *
 * Several UC-1 panels carry an always-open `CalciteNotice` explaining a data source
 * or a workflow — useful context, but long and permanently taking space. This
 * consolidates that pattern behind one consistent, unobtrusive affordance: the icon
 * shows by default; clicking it toggles a small callout holding the SAME wording;
 * clicking the icon again, clicking outside, or pressing Esc hides it.
 *
 * Only the PRESENTATION changes — the text passed as children is unchanged.
 *
 * The callout is positioned `fixed` from the icon's on-screen rect, so it never gets
 * clipped by a scrolling table or an `overflow` ancestor (the reason the first,
 * popover-anchored version failed to show its content).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CalciteIcon } from '@esri/calcite-components-react';
import { tokens } from '@/theme/tokens';

const MAX_W = 360;

export function InfoPopover({
  heading,
  label = 'More information',
  children,
}: {
  /** Optional bold heading at the top of the callout (e.g. the notice's former title). */
  heading?: string;
  /** Accessible name / hover tooltip for the icon button. */
  label?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Clamp so a right-edge icon does not push the callout off-screen.
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MAX_W - 12));
      setPos({ top: r.bottom + 6, left });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // A scroll detaches the fixed callout from its icon — close instead of drift.
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={toggle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: open ? tokens.text : tokens.accent,
          cursor: 'pointer',
          verticalAlign: 'middle',
        }}
      >
        <CalciteIcon icon="information" scale="s" />
      </button>
      {open && pos && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={heading ?? label}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 9999,
            maxWidth: MAX_W,
            background: tokens.panel,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
            padding: `${tokens.space.sm}px ${tokens.space.md}px`,
            fontSize: 12,
            lineHeight: 1.5,
            color: tokens.text,
          }}
        >
          {heading && <div style={{ fontWeight: 700, marginBottom: 4 }}>{heading}</div>}
          {children}
        </div>
      )}
    </>
  );
}
