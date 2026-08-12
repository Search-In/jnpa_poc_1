/**
 * <MapVesselPopup> — a small, compact card shown ON the 3D map for the clicked
 * vessel, with the SAME fields the Esri vessel popup shows (fed by <PortScene>
 * from the clicked graphic's own `attributes` — no fetch, no compute, no
 * hardcoding).
 *
 * RENDERED VIA A PORTAL TO document.body, `position: fixed`, at the click's
 * VIEWPORT coordinates. This is deliberate: rendering it as a child/sibling of
 * the ArcGIS SceneView container left it painted behind the WebGL canvas / clipped
 * by the view's stacking context (the reason earlier attempts were invisible).
 * Fixed + a very high z-index keeps it above the map regardless of the SceneView
 * DOM. It is clamped to stay fully inside the viewport.
 *
 * Only the card is interactive; a click inside it (including ×) is stopped so it
 * never reaches the map or the outside-click close handler.
 */
import { tokens } from '../theme/tokens';

export interface MapPopupField {
  label: string;
  value: string;
}

export interface MapVesselPopupProps {
  title: string;
  fields: MapPopupField[];
  /** Click position in VIEWPORT (client) pixels. */
  x: number;
  y: number;
  onClose: () => void;
}

const CARD_W = 264;
const PAD = 12;

export function MapVesselPopup({ title, fields, x, y, onClose }: MapVesselPopupProps) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const estH = 52 + fields.length * 20;

  // Offset from the click, then clamp so the card is always fully on-screen.
  let left = x + 14;
  let top = y + 14;
  if (left + CARD_W + PAD > vw) left = x - CARD_W - 14;
  if (left < PAD) left = PAD;
  if (top + estH + PAD > vh) top = Math.max(PAD, vh - estH - PAD);
  if (top < PAD) top = PAD;

  return (
    <div
      role="dialog"
      aria-label={`${title} details`}
      data-map-popup="1"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 100000,
        width: CARD_W,
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.sm,
        boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
        fontSize: 12,
        color: tokens.text,
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 8px',
          background: tokens.panelAlt,
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        <span
          style={{
            fontWeight: 700,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </span>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          style={{
            flex: '0 0 auto',
            border: 'none',
            background: 'transparent',
            color: tokens.textMuted,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          padding: '6px 8px',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 10,
          rowGap: 3,
          maxHeight: 260,
          overflow: 'auto',
        }}
      >
        {fields.map((f) => (
          <div key={f.label} style={{ display: 'contents' }}>
            <span style={{ color: tokens.textMuted, whiteSpace: 'nowrap' }}>{f.label}</span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
