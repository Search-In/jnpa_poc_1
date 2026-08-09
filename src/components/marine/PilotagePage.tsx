/**
 * <PilotagePage> — the whole Pilotage screen.
 *
 *   Pilotage
 *     └── [ Active Pilot Operations ] [ Pilot Register ] [ Pilot Memo / Acks ] [ Data Upload ]
 *                    ▲ default
 *
 * State follows the App shell's existing sub-tab pattern exactly — plain useState in the
 * screen's parent, the same as <PortCraftPage> and Vessels ▸ …. No store, no
 * persistence, no router state: sub-tab selection is not persisted anywhere here.
 */

import { useState } from 'react';
import { PilotageTabs, type PilotageSubTab } from '@/components/marine/PilotageTabs';

export interface PilotagePageProps {
  /**
   * Bumped by the App shell after a vessel-call import so the pilot panes remount and
   * refetch, exactly as the old single PilotageTable did via its `key`.
   */
  uploadKey?: number;
}

export function PilotagePage({ uploadKey = 0 }: PilotagePageProps) {
  const [subTab, setSubTab] = useState<PilotageSubTab>('operations');
  // Local bump for imports made on THIS screen's own Data Upload tab; combined with the
  // shell's counter so either source refreshes the panes.
  const [localKey, setLocalKey] = useState(0);

  return (
    <PilotageTabs
      active={subTab}
      onActivate={setSubTab}
      registerKey={uploadKey + localKey}
      onImported={() => setLocalKey((k) => k + 1)}
    />
  );
}
