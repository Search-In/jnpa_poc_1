/**
 * <AnomalyMark> — a warning glyph for a VERIFIED data-quality or correlation issue.
 *
 * Marks the affected FIELD, never the row. Uses the app's existing warning token and the
 * native `title` tooltip idiom the tables already use (see dataTable.tsx) — no new
 * component library, no popover dependency.
 *
 * WHAT MAY BE PASSED TO THIS
 * --------------------------
 * Only a condition the BACKEND already reports as a distinct state. In practice that is
 * the correlation outcome: `/api/marine/state/berthing` returns `lifecycle: null` for a
 * report whose VIA resolved to no vessel call, and the service documents that as "a REAL
 * finding … not an error".
 *
 * WHAT MUST NOT
 * -------------
 * An empty value is NOT an anomaly. A blank ATD while a vessel is at berth, a pending
 * departure, cargo not started — all normal lifecycle states. Nothing here infers,
 * predicts or scores; if the response carries no anomaly information, no mark is shown.
 *
 * Not colour-only: the glyph is text, it carries `role="img"` with an accessible name,
 * and the same wording is in `title` for sighted hover.
 */

import { tokens } from '@/theme/tokens';

export function AnomalyMark({ reason }: { reason: string }) {
  return (
    <span
      role="img"
      aria-label={`Warning: ${reason}`}
      title={reason}
      style={{ color: tokens.warn, marginLeft: 4, cursor: 'help', fontSize: 12 }}
    >
      ⚠
    </span>
  );
}
