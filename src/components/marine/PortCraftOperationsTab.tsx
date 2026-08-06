/**
 * <PortCraftOperationsTab> — the Active Marine Operations tab of the Port Craft screen.
 *
 * Presentation-only wrapper, the same shape as <PortCraftFleetRegister>: it supplies the
 * Panel framing (title + bounded 420px viewport) and nothing else. Every behaviour — the
 * `/api/marine/state/port-craft` read through the UC-3 connector, the lifecycle columns,
 * the search / movement / status filters, the pager and the styling — lives inside
 * <PortCraftActiveOperations> and is untouched here.
 */

import { Panel } from '@/components/common/Panel';
import { PortCraftActiveOperations } from '@/components/marine/PortCraftActiveOperations';

export function PortCraftOperationsTab() {
  return (
    <Panel title="Active marine operations — vessels currently requiring marine support" height={420}>
      <PortCraftActiveOperations />
    </Panel>
  );
}
