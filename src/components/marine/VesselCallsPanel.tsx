/**
 * <VesselCallsPanel> — composes the Vessels ▸ Vessel Calls sub-tab: the KPI cards
 * on top, then a two-column split of the paged call table (left) and the selected
 * call's timeline (right). Selection state lives here and drives the timeline.
 *
 * All reads go through the Phase-1 uc3/marineCalls connector via useAdapterQuery.
 * This surface is entirely UC-3-backed and independent of the AIS/simulator feed —
 * nothing here touches the vessel store or the mock adapter.
 */

import { useState } from 'react';
import { VesselCallsTable } from './VesselCallsTable';
import { VesselCallTimeline } from './VesselCallTimeline';
import { MarineStatCards } from './MarineStatCards';
import { Panel } from '@/components/common/Panel';
import type { VesselCall } from '@/types/domain';

export function VesselCallsPanel() {
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title="Vessel calls — UC-3 backend (core.vessel_call)" minHeight={120}>
        <MarineStatCards />
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)', gap: 12, alignItems: 'stretch' }}>
        <Panel title="Vessel calls" height={520}>
          <VesselCallsTable
            selectedCallId={selectedCallId}
            onRowClick={(c: VesselCall) => setSelectedCallId(c.callId)}
          />
        </Panel>
        <Panel title="Call timeline" height={520}>
          <VesselCallTimeline callId={selectedCallId} />
        </Panel>
      </div>
    </div>
  );
}
