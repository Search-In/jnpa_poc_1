/**
 * ConfigWarningBanner — a header-level notice for configuration that is wrong in
 * a way the operator cannot see from the screen itself.
 *
 * Today it carries exactly one message: an unrecognised `VITE_DATA_MODE`, which
 * falls back to simulated data (see src/data/dataMode.ts). `vite.config.ts`
 * already fails the build on that value, so this banner is the backstop for a
 * value injected into an ALREADY-BUILT bundle — an nginx substitution, a
 * hand-edited config on the demo machine — which the build could never have seen.
 *
 * Renders nothing when the configuration is sound, so it costs a demo nothing.
 */
import { CalciteNotice } from '@esri/calcite-components-react';
import { env } from '@/data/config';

export function ConfigWarningBanner() {
  if (!env.dataModeWarning) return null;

  return (
    <CalciteNotice
      open
      kind="warning"
      icon="exclamation-mark-triangle"
      scale="s"
      width="full"
      role="alert"
    >
      <div slot="title">Configuration problem — this screen is showing simulated data</div>
      <div slot="message">{env.dataModeWarning}</div>
    </CalciteNotice>
  );
}
