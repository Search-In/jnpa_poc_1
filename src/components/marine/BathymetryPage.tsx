/**
 * <BathymetryPage> — the whole Bathymetry section, mounted under DUKC / RTUKC.
 *
 * Layout:
 *
 *   DUKC / RTUKC ▸ Bathymetry
 *     └── [ Overview ] [ Surveys ] [ Data Upload ]
 *              ▲ default
 *
 * Mirrors <PortCraftPage> exactly: this component owns the section's state, the
 * presentation lives in <BathymetryTabs>. State follows the App shell's existing
 * sub-tab pattern — plain useState in the screen's parent, the same as Vessels ▸ …,
 * DUKC ▸ Sea Channels and Port Craft ▸ …. No store, no persistence, no router state.
 *
 * Bathymetry sits under DUKC rather than claiming a top-level tab because it IS the
 * depth domain: the soundings are the survey evidence behind the charted depths the
 * DUKC corridor computes under-keel clearance from. The tab bar is also already at 14
 * entries, so a 15th would wrap.
 *
 * Unlike Port Craft this screen needs no guided-tour snap-back: no step in
 * sim/scenarios.ts drives `tab: 'dukc'` with a bathymetry beat.
 */

import { useState } from 'react';
import { BathymetryTabs, type BathymetrySubTab } from '@/components/marine/BathymetryTabs';

export function BathymetryPage() {
  // Overview is the default: the section opens on the survey coverage picture.
  const [subTab, setSubTab] = useState<BathymetrySubTab>('overview');
  // Bumped after a successful chart import so the Overview and Surveys panes remount
  // and refetch. Presentation-only — no query logic changes.
  const [registerKey, setRegisterKey] = useState(0);

  return (
    <BathymetryTabs
      active={subTab}
      onActivate={setSubTab}
      registerKey={registerKey}
      onImported={() => setRegisterKey((k) => k + 1)}
    />
  );
}
