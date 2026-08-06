/**
 * <PortCraftFleetRegister> — the Fleet Register tab of the Port Craft screen.
 *
 * Presentation-only wrapper that keeps the Panel framing the register has always
 * had (same title, same 420px bounded viewport) so the table renders exactly as
 * before. All table behaviour — the `/api/marine/port-craft` read through the UC-3
 * connector, the response mapping, the columns, the server-side `name asc`
 * ordering, the search / craft-type / ownership filters, the pager and the styling
 * — stays inside <PortCraftRegisterTable> and is untouched here.
 *
 * `registerKey` remounts the table after a successful upload on the Data Upload
 * tab; that is the register's only refetch trigger.
 */

import { Panel } from '@/components/common/Panel';
import { PortCraftRegisterTable } from '@/components/marine/PortCraftRegisterTable';

export interface PortCraftFleetRegisterProps {
  /** Bumped after a successful import so the table remounts and refetches. */
  registerKey: number;
}

export function PortCraftFleetRegister({ registerKey }: PortCraftFleetRegisterProps) {
  return (
    <Panel title="Port-craft fleet register — UC-3 backend (core.port_craft)" height={420}>
      <PortCraftRegisterTable key={registerKey} />
    </Panel>
  );
}
