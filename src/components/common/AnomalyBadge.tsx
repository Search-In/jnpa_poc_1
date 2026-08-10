/**
 * <AnomalyBadge> — marks a RECORD whose import is materially incomplete.
 *
 * Distinct from <AnomalyMark>, and both are kept:
 *   AnomalyMark   one FIELD, a backend-reported correlation failure.
 *   AnomalyBadge  one RECORD, more than `threshold` configured business fields missing.
 *
 * The badge is never inferred here — it renders a decision already made by
 * `assessRecord`, and names the missing fields in its tooltip so an operator can act on
 * it rather than just seeing a warning.
 *
 * Not colour-only: the text reads ANOMALY, it carries an accessible name, and the same
 * wording is in `title` for sighted hover — matching <AnomalyMark>'s contract.
 */

import type { QualityResult } from '@/data/quality/dataQuality';
import { describeAnomaly } from '@/data/quality/dataQuality';
import { tokens } from '@/theme/tokens';

export interface AnomalyBadgeProps {
  result: QualityResult;
  /** Dataset name for the tooltip, e.g. 'Vessel Call'. */
  dataset: string;
}

export function AnomalyBadge({ result, dataset }: AnomalyBadgeProps) {
  if (!result.isAnomaly) return null;
  const text = describeAnomaly(result, dataset);
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      style={{
        marginLeft: 6,
        fontSize: 9.5,
        fontWeight: 800,
        letterSpacing: 0.4,
        padding: '1px 5px',
        borderRadius: tokens.radius.sm,
        color: tokens.warn,
        border: `1px solid ${tokens.warn}`,
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      }}
    >
      ANOMALY
    </span>
  );
}
