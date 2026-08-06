/**
 * <PortCraftPage> — the whole Port Craft tab, extracted out of the App shell.
 *
 * Layout:
 *
 *   Port Craft
 *     └── [ Overview ] [ Fleet Register ] [ Data Upload ]
 *              ▲ default
 *
 * State follows the App shell's existing sub-tab pattern exactly — plain useState in
 * the screen's parent, the same as Vessels ▸ …, DUKC ▸ Sea Channels and 5-Day
 * Berthing ▸ …. No store, no persistence, no router state: sub-tab selection is not
 * persisted anywhere in this project. The two values here are the ones that used to
 * live in App (`craftSubTab`, `portCraftUploadKey`).
 */

import { useEffect, useState } from 'react';
import { PortCraftTabs, type PortCraftSubTab } from '@/components/marine/PortCraftTabs';
import { useSimStore } from '@/sim/simStore';

export function PortCraftPage() {
  // Overview is the default: the tab opens on the live operational picture.
  const [subTab, setSubTab] = useState<PortCraftSubTab>('overview');
  // Bumped after a successful port-craft import so the register remounts and
  // refetches. Presentation-only — no query logic changes.
  const [registerKey, setRegisterKey] = useState(0);

  // Guided-tour safety. Six steps in sim/scenarios.ts drive `tab: 'craft'` and narrate
  // the resource board directly ("the board flags the shortfall", "the board proposes a
  // swap"). Before Overview became a tab the board was always on screen, so those beats
  // could not miss. This screen stays mounted across App tab switches, so without the
  // snap-back below a tour beat would land on whichever sub-tab the operator last left
  // open. Derived from existing store state — no new state is introduced.
  const tourBeat = useSimStore((s) => (s.tour.scenarioId ? `${s.tour.scenarioId}:${s.tour.step}` : null));
  useEffect(() => {
    if (tourBeat) setSubTab('overview');
  }, [tourBeat]);

  return (
    <PortCraftTabs
      active={subTab}
      onActivate={setSubTab}
      registerKey={registerKey}
      onImported={() => setRegisterKey((k) => k + 1)}
    />
  );
}
