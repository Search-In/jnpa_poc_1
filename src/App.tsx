/**
 * App shell — JNPA Vessel Traffic Management & Optimisation (UC-1), Calcite dark.
 *
 * The 3D sea-port scene is the anchor and the default first-load view (spec §A6):
 * a living JNPA approach with channel, anchorages, berths and live (simulated)
 * vessel motion, framed by a KPI rail and a tabbed operations panel. A persistent
 * DATA_MODE provenance chip (default SIMULATED) sits in the header; clicking it
 * opens the Integration Simulator Console. The What-If Reactive Guide, Guided
 * Tour and Integration Console ride as overlays.
 *
 * Structural rebuild in place: the tested KPI engine, DataAdapter and Nhava Sheva
 * fixtures are preserved; every platform module (3D scene, provenance, DUKC,
 * scenarios, workflows) is new and marine-specific.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CalciteShell,
  CalciteShellPanel,
  CalcitePanel,
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
  CalciteButton,
  CalciteChip,
} from '@esri/calcite-components-react';
import { HeaderBar } from '@/components/HeaderBar';
import { DataModeChip } from '@/provenance/DataModeChip';
import { RoleSwitcher } from '@/auth/RoleSwitcher';
import { IntegrationConsole } from '@/console/IntegrationConsole';
import { KpiStrip } from '@/components/KpiStrip';
import { AISMap } from '@/components/AISMap';
import { VesselFeed } from '@/components/VesselFeed';
import { VesselTable } from '@/components/VesselTable';
import { VesselCallsPanel } from '@/components/marine/VesselCallsPanel';
import { PilotageTable } from '@/components/marine/PilotageTable';
import { MarineUploadPanel } from '@/components/marine/MarineUploadPanel';
import { PortScene, type PortSceneHandle, type CameraPreset } from '@/map/PortScene';
import { DemoPlayer } from '@/sim/DemoPlayer';
import { SimControls } from '@/sim/SimControls';
import { PlacementToolbar } from '@/map/PlacementToolbar';
import { Panel } from '@/components/common/Panel';
import { BerthGantt5Day } from '@/components/reports/BerthGantt5Day';
import { BerthingStats } from '@/components/berthing/BerthingStats';
import { BerthingReportsTable } from '@/components/berthing/BerthingReportsTable';
import { BerthingUploadPanel } from '@/components/berthing/BerthingUploadPanel';
import { ShippingLinesTable } from '@/components/shipping/ShippingLinesTable';
import { ShippingLinesSummaryCards } from '@/components/shipping/ShippingLinesSummaryCards';
import { ShippingLinesUploadPanel } from '@/components/shipping/ShippingLinesUploadPanel';
import { PlanImportPanel } from '@/planning/PlanImportPanel';
import { ArrivalsDepartures } from '@/components/reports/ArrivalsDepartures';
import { JustInTime } from '@/components/reports/JustInTime';
import { DelayTrend } from '@/components/reports/DelayTrend';
import { PortCraftBoard } from '@/components/reports/PortCraftBoard';
import { PortCraftRegisterTable } from '@/components/marine/PortCraftRegisterTable';
import { PredictionConvergence } from '@/components/reports/PredictionConvergence';
import { PredictionAccuracy } from '@/components/reports/PredictionAccuracy';
import { PortCraftPerformance } from '@/components/reports/PortCraftPerformance';
import { PilotPerformancePanel } from '@/components/marine/PilotPerformancePanel';
import { PreBerthingBoard } from '@/components/marine/PreBerthingBoard';
import { DukcCorridor } from '@/components/reports/DukcCorridor';
import { SeaChannelTable } from '@/components/marine/SeaChannelTable';
import { WeatherPanel } from '@/components/WeatherPanel';
import { TideSeaStatePanel } from '@/components/TideSeaStatePanel';
import { TideFieldLegend } from '@/components/TideFieldLegend';
import { useTideFieldStore } from '@/map/tideFieldStore';
import { Scenarios } from '@/sim/ScenariosPanel';
import { GuidedTour } from '@/sim/GuidedTour';
import { ReactiveGuide } from '@/whatif/ReactiveGuide';
import { WorkflowRuns } from '@/workflow/WorkflowRuns';
import { WorkflowComposer } from '@/workflow/WorkflowComposer';
import { ConnectorReadiness } from '@/console/ConnectorReadiness';
import { AnalyticsPanel } from '@/planning/AnalyticsPanel';
import { MethodologyPanel } from '@/components/MethodologyPanel';
import { ExportToolbar } from '@/reports/ExportToolbar';
import { KPI_TARGETS } from '@/config/targets';
import type { Berth } from '@/types/domain';
import { useAppStore } from '@/store/useAppStore';
import { useSimStore } from '@/sim/simStore';
import { SCENARIOS, scenarioLevers } from '@/sim/scenarios';
import { useSimClock } from '@/sim/useSimClock';
import { useSimReactivity } from '@/sim/useSimReactivity';
import { tokens } from '@/theme/tokens';

const TABS = [
  { id: 'kpis', label: 'KPI Wall' },
  { id: 'vessels', label: 'Vessels' },
  { id: 'tide', label: 'Tide & Sea State' },
  { id: 'gantt', label: '5-Day Berthing' },
  { id: 'plan', label: 'Plan Import' },
  { id: 'dukc', label: 'DUKC / RTUKC' },
  { id: 'craft', label: 'Port Craft' },
  { id: 'scenarios', label: 'What-If' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'analytics', label: 'Analytics & JIT' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'reports', label: 'Reports' },
  { id: 'methodology', label: 'Methodology' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  // Store lifecycle: vessel stream + KPI refresh (no auth — runs credential-free).
  useEffect(() => {
    useSimStore.getState().restore();
    return useAppStore.getState().start();
  }, []);
  useSimClock();
  useSimReactivity();

  // Suite deep-link: `?scenario=<id>` opens straight into a what-if (parity with
  // UC-2/UC-3), so the Suite DTCCC console can drive UC-1 as part of the
  // cross-domain Monsoon-Friday chain. Deck/VTM ids map to the native M-ids:
  //   VTM-1 (ship bunching)->M5 · VTM-2 (adverse weather)->M1 · VTM-3 (tidal
  //   window closure / 14.5 m draft)->M2 · MONSOON-FRIDAY (suite trigger)->M2.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const raw = q.get('scenario');
    if (!raw) return;
    const MAP: Record<string, string> = {
      'VTM-1': 'M5', 'VTM-2': 'M1', 'VTM-3': 'M2', 'MONSOON-FRIDAY': 'M2',
    };
    const id = MAP[raw.toUpperCase()] ?? raw;
    if (!SCENARIOS.some((s) => s.id === id)) return;
    const st = useSimStore.getState();
    if (st.scenarioId != null) return; // don't clobber an in-progress run
    st.loadScenario(id, scenarioLevers(id));
    if (q.get('auto') !== '0') st.startTour(id, true);
  }, []);

  const vessels = useAppStore((s) => s.vessels);
  const [berths, setBerths] = useState<Berth[]>([]);
  const highlights = useSimStore((s) => s.highlights);
  // Re-fetch berths (through SimAdapter) whenever the operator stages a data
  // override, so forced berth statuses reach the 3D scene live.
  const simVersion = useSimStore((s) => s.version);

  const [mapMode, setMapMode] = useState<'2d' | '3d'>('3d'); // 3D is the default first-load view (§A6)
  const tideFieldVisible = useTideFieldStore((s) => s.visible);
  const toggleTideField = useTideFieldStore((s) => s.toggleVisible);
  const [activeTab, setActiveTab] = useState<TabId>('kpis');
  // Vessels tab sub-view. 'live' (the existing AIS feed) is the default so the tab
  // opens exactly as before; 'calls'/'upload' are the new UC-3 Marine surfaces.
  const [vesselSubTab, setVesselSubTab] = useState<'live' | 'calls' | 'pilotage' | 'upload' | 'shipping'>('live');
  // Shipping Lines section sub-view (nested under Vessels ▸ Shipping Lines): 'registry'
  // (summary + carrier table, the default) or 'upload' (advance-list Data Upload).
  const [shippingSubTab, setShippingSubTab] = useState<'registry' | 'upload'>('registry');
  // Bumped after a successful shipping-line import so the sibling registry + summary
  // remount and refetch. Presentation-only — no query logic changes.
  const [shippingRegistryKey, setShippingRegistryKey] = useState(0);
  // Bumped after a successful vessel-call import so the sibling (mounted-but-hidden)
  // VesselCallsPanel remounts and refetches — without this the calls table keeps the
  // stale pre-import result. Presentation-only — no query logic changes.
  const [vesselCallUploadKey, setVesselCallUploadKey] = useState(0);
  // DUKC tab sub-view. 'analysis' (the existing DukcCorridor / RTUKC view) is the default
  // so the tab opens exactly as before; 'channels' hosts the sea-channel section.
  const [dukcSubTab, setDukcSubTab] = useState<'analysis' | 'channels'>('analysis');
  // Sea Channels section sub-view (nested under DUKC ▸ Sea Channels): 'data' (the
  // SeaChannelTable, the default) or 'upload' (MarineUploadPanel + upload history).
  const [seaChannelSubTab, setSeaChannelSubTab] = useState<'data' | 'upload'>('data');
  // Bumped after a successful sea-channel import so the sibling SeaChannelTable remounts
  // and refetches (DUKC ▸ Sea Channels). Presentation-only — no query logic changes.
  const [seaChannelUploadKey, setSeaChannelUploadKey] = useState(0);
  // Port Craft tab sub-view. 'list' (the existing board + register, the default) or
  // 'upload' (MarineUploadPanel + upload history).
  const [craftSubTab, setCraftSubTab] = useState<'list' | 'upload'>('list');
  // Bumped after a successful port-craft import so the sibling PortCraftRegisterTable
  // remounts and refetches. Presentation-only — no query logic changes.
  const [portCraftUploadKey, setPortCraftUploadKey] = useState(0);
  // 5-Day Berthing tab sub-view. 'plan' (the existing sim/adapter berth-plan gantt) is
  // the default so the tab opens exactly as before; 'reports' hosts the UC-3 terminal
  // berthing-report actuals + stats, 'upload' the berthing Data-Upload flow.
  const [berthingSubTab, setBerthingSubTab] = useState<'plan' | 'reports' | 'preberth' | 'upload'>('plan');
  // Bumped after a successful berthing import so the sibling Terminal Reports view
  // remounts and refetches. Presentation-only — no query logic changes.
  const [berthingReportsKey, setBerthingReportsKey] = useState(0);
  const [offlineBase, setOfflineBase] = useState(false);
  // Scene handle in state (not just a ref) so the DemoPlayer re-renders once the
  // SceneView is mounted and can receive the imperative handle. The callback ref
  // MUST be stable (useCallback) — an inline function is a new identity each
  // render, which makes React detach+reattach the ref (null → handle) every
  // render, and calling setScene there would loop forever. We also only setScene
  // on an actual identity change.
  const [scene, setScene] = useState<PortSceneHandle | null>(null);
  const sceneRef = useRef<PortSceneHandle | null>(null);
  const setSceneRef = useCallback((h: PortSceneHandle | null) => {
    if (sceneRef.current === h) return;
    sceneRef.current = h;
    setScene(h);
  }, []);

  // Load berths once (and refetch when the scene needs them). Kept simple — the
  // 3D scene + gantt both read berths; the store already streams vessels.
  useEffect(() => {
    let alive = true;
    void import('@/data').then(({ getAdapter }) =>
      getAdapter()
        .getBerths()
        .then((b) => {
          if (alive) setBerths(b as never);
        })
        .catch(() => {}),
    );
    return () => {
      alive = false;
    };
  }, [simVersion]);

  // Guided tour drives the camera + active tab + map highlights per step.
  // MUST be stable (useCallback): GuidedTour lists this in a useEffect dep array,
  // so a fresh identity each render would re-fire that effect → setHighlights →
  // version bump → App re-render → new identity … an infinite update loop that
  // white-screens the app whenever a scenario/tour is running. mapMode is read
  // through a ref-free closure dep so flips still fly the camera correctly.
  const onTourStep = useCallback(
    (s: { preset: string; tab: string; highlights: string[] }) => {
      if (s.tab && TABS.some((t) => t.id === s.tab)) setActiveTab(s.tab as TabId);
      if (mapMode === '3d') sceneRef.current?.goToPreset(s.preset as CameraPreset);
    },
    [mapMode],
  );

  return (
    <>
      <CalciteShell style={{ height: '100vh', background: tokens.bg }}>
        <div slot="header">
          <HeaderBar
            extra={
              <>
                <RoleSwitcher />
                <SimControls />
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  kind="brand"
                  iconStart="sliders-horizontal"
                  title="Open the Simulator control room in a new tab — its controls drive this dashboard live"
                  onClick={() => window.open('#/simulator', '_blank')}
                >
                  Simulator
                </CalciteButton>
                <DataModeChip />
              </>
            }
          />
        </div>

        {/* Left: the 3D sea-port scene is the anchor + default view. A 2D/3D
            toggle flips it to the flat AIS map. The DemoPlayer (camera bookmarks
            + opening choreography) rides over the 3D scene. */}
        <CalciteShellPanel
          slot="panel-start"
          widthScale="l"
          resizable
          style={{
            '--calcite-shell-panel-min-width': '360px',
            '--calcite-shell-panel-width': '46vw',
            '--calcite-shell-panel-max-width': '90vw',
          } as React.CSSProperties}
        >
          <CalcitePanel heading={mapMode === '3d' ? 'JNPA Sea-Port · 3D' : 'Live AIS Map · JNPA approaches'}>
            <div style={{ height: 'calc(100vh - 120px)', position: 'relative' }}>
              {mapMode === '3d' ? (
                <PortScene
                  ref={setSceneRef}
                  vessels={vessels}
                  berths={berths}
                  highlights={highlights}
                  onOfflineBasemap={() => setOfflineBase(true)}
                />
              ) : (
                <AISMap />
              )}

              {/* Map-mode controls — floated ON the map (top-right) as an overlay,
                  like the camera-preset bar, rather than sitting in a bar above
                  the map. */}
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  right: 10,
                  zIndex: 5,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  justifyContent: 'flex-end',
                  maxWidth: 'calc(100% - 20px)',
                  padding: 6,
                  background: `${tokens.panel}E6`,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  boxShadow: '0 2px 8px rgba(0,0,0,.35)',
                }}
              >
                {offlineBase && (
                  <CalciteChip scale="s" kind="inverse" icon="offline">
                    Offline basemap
                  </CalciteChip>
                )}
                {/* 3D asset placement editing (shared positions.json workflow). */}
                {mapMode === '3d' && <PlacementToolbar />}
                <CalciteButton
                  scale="s"
                  appearance={tideFieldVisible ? 'solid' : 'outline'}
                  iconStart="temperature"
                  title="Toggle the INCOIS-style tide & sea-state heatmap field"
                  onClick={() => toggleTideField()}
                >
                  Tide field
                </CalciteButton>
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="exclamation-mark-triangle"
                  title="Rehearse ArcGIS token-death: reloads with the bundled offline basemap"
                  onClick={() => {
                    const u = new URL(window.location.href);
                    u.searchParams.set('offline', '1');
                    window.location.href = u.toString();
                  }}
                >
                  Simulate token expiry
                </CalciteButton>
                <CalciteSegmentedControl
                  width="auto"
                  scale="s"
                  onCalciteSegmentedControlChange={(e) =>
                    setMapMode(((e.target as unknown as { value: '2d' | '3d' }).value) === '3d' ? '3d' : '2d')
                  }
                >
                  <CalciteSegmentedControlItem value="2d" checked={mapMode === '2d'} iconStart="map">
                    2D
                  </CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="3d" checked={mapMode === '3d'} iconStart="urban-model">
                    3D
                  </CalciteSegmentedControlItem>
                </CalciteSegmentedControl>
              </div>

              {/* Camera-preset bar (3D only) — floated on the map bottom-centre. */}
              {mapMode === '3d' && (
                <div style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
                  <DemoPlayer scene={scene} />
                </div>
              )}

              {/* Tide/sea-state colorbar + variable selector — INCOIS-OSF style,
                  floated bottom-right, shown when the heatmap field is on. */}
              {tideFieldVisible && (
                <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 5 }}>
                  <TideFieldLegend />
                </div>
              )}
            </div>
          </CalcitePanel>
        </CalciteShellPanel>

        {/* Center/right: KPI strip + tabbed operations panels. */}
        <CalcitePanel>
          <div style={{ padding: 12 }}>
            <KpiStrip />
          </div>
          <CalciteTabs layout="inline" style={{ padding: 12 }}>
            <CalciteTabNav slot="title-group">
              {TABS.map((tb) => (
                <CalciteTabTitle
                  key={tb.id}
                  tab={tb.id}
                  selected={activeTab === tb.id}
                  onCalciteTabsActivate={() => setActiveTab(tb.id)}
                >
                  {tb.label}
                </CalciteTabTitle>
              ))}
            </CalciteTabNav>

            <CalciteTab tab="kpis" selected={activeTab === 'kpis'}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
                <Panel title="Prediction vs Actual — convergence" minHeight={280}>
                  <PredictionConvergence />
                </Panel>
                <Panel title="Just-In-Time Arrivals" minHeight={280}>
                  <JustInTime />
                </Panel>
                <Panel title="Pre-Berthing Delay vs target" minHeight={260}>
                  <DelayTrend field="PRE_BERTH_DELAY" target={KPI_TARGETS.preBerthingDelay.target} unit="h" label="Pre-berthing delay" />
                </Panel>
                <Panel title="Average Vessel TAT vs target" minHeight={260}>
                  <DelayTrend field="AVG_TAT" target={KPI_TARGETS.avgTat.target} unit="h" label="Avg TAT" />
                </Panel>
                {/* Spec UI-044 (screen M-09): predicted-vs-actual arrival accuracy —
                    previously built but never mounted (audit item D9). */}
                <Panel title="ETA Prediction Accuracy" minHeight={260}>
                  <PredictionAccuracy />
                </Panel>
              </div>
            </CalciteTab>

            <CalciteTab tab="vessels" selected={activeTab === 'vessels'}>
              <CalciteTabs layout="inline">
                <CalciteTabNav slot="title-group">
                  <CalciteTabTitle tab="v-live" selected={vesselSubTab === 'live'} onCalciteTabsActivate={() => setVesselSubTab('live')}>
                    Live AIS Feed
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="v-calls" selected={vesselSubTab === 'calls'} onCalciteTabsActivate={() => setVesselSubTab('calls')}>
                    Vessel Calls
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="v-pilotage" selected={vesselSubTab === 'pilotage'} onCalciteTabsActivate={() => setVesselSubTab('pilotage')}>
                    Pilotage
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="v-upload" selected={vesselSubTab === 'upload'} onCalciteTabsActivate={() => setVesselSubTab('upload')}>
                    Data Upload
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="v-shipping" selected={vesselSubTab === 'shipping'} onCalciteTabsActivate={() => setVesselSubTab('shipping')}>
                    Shipping Lines
                  </CalciteTabTitle>
                </CalciteTabNav>

                {/* Existing AIS feed — unchanged, and the DEFAULT sub-tab. */}
                <CalciteTab tab="v-live" selected={vesselSubTab === 'live'}>
                  <Panel title="All vessels — live AIS feed" height={640}>
                    <VesselTable />
                  </Panel>
                </CalciteTab>

                {/* New: UC-3 vessel calls (core.vessel_call). Keyed on the upload counter so a
                    successful import on the Data Upload sub-tab remounts it and refetches. */}
                <CalciteTab tab="v-calls" selected={vesselSubTab === 'calls'}>
                  <VesselCallsPanel key={vesselCallUploadKey} />
                </CalciteTab>

                {/* New: UC-3 pilotage movements (core.pilotage). */}
                <CalciteTab tab="v-pilotage" selected={vesselSubTab === 'pilotage'}>
                  <Panel title="Pilotage movements — UC-3 backend (core.pilotage)" height={640}>
                    <PilotageTable />
                  </Panel>
                </CalciteTab>

                {/* New: UC-3 vessel-call upload (CSV + BERMAN/CALINF/VESPRO XML + pilot XLSX).
                    On a successful import, bump the key so the Vessel Calls sub-tab refetches. */}
                <CalciteTab tab="v-upload" selected={vesselSubTab === 'upload'}>
                  <MarineUploadPanel onImported={() => setVesselCallUploadKey((k) => k + 1)} />
                </CalciteTab>

                {/* New: UC-3 Shipping Lines (jnpa.sl_* carrier registry + advance lists) — a
                    marine reference entity, its own nested Registry / Data Upload tabs, same
                    inline style as the DUKC ▸ Sea Channels sub-tabs. */}
                <CalciteTab tab="v-shipping" selected={vesselSubTab === 'shipping'}>
                  <CalciteTabs layout="inline">
                    <CalciteTabNav slot="title-group">
                      <CalciteTabTitle tab="sl-registry" selected={shippingSubTab === 'registry'} onCalciteTabsActivate={() => setShippingSubTab('registry')}>
                        Registry
                      </CalciteTabTitle>
                      <CalciteTabTitle tab="sl-upload" selected={shippingSubTab === 'upload'} onCalciteTabsActivate={() => setShippingSubTab('upload')}>
                        Data Upload
                      </CalciteTabTitle>
                    </CalciteTabNav>

                    {/* Summary cards + carrier registry — the DEFAULT. Keyed on the upload
                        counter so a successful import remounts + refetches both. */}
                    <CalciteTab tab="sl-registry" selected={shippingSubTab === 'registry'}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} key={shippingRegistryKey}>
                        <Panel title="Shipping lines — UC-3 backend (jnpa.shipping_lines)" minHeight={120}>
                          <ShippingLinesSummaryCards />
                        </Panel>
                        <Panel title="Carrier registry" height={520}>
                          <ShippingLinesTable />
                        </Panel>
                      </div>
                    </CalciteTab>

                    {/* Advance-list / delivery-order Data Upload (IAL/EAL/EDO). On import,
                        bump the key so the Registry sub-tab refetches. */}
                    <CalciteTab tab="sl-upload" selected={shippingSubTab === 'upload'}>
                      <ShippingLinesUploadPanel onImported={() => setShippingRegistryKey((k) => k + 1)} />
                    </CalciteTab>
                  </CalciteTabs>
                </CalciteTab>
              </CalciteTabs>
            </CalciteTab>

            <CalciteTab tab="tide" selected={activeTab === 'tide'}>
              <Panel title="Tide & Sea State — INCOIS OSF (interim: Open-Meteo Marine)" height={640}>
                <TideSeaStatePanel />
              </Panel>
            </CalciteTab>

            <CalciteTab tab="gantt" selected={activeTab === 'gantt'}>
              <CalciteTabs layout="inline">
                <CalciteTabNav slot="title-group">
                  <CalciteTabTitle tab="b-plan" selected={berthingSubTab === 'plan'} onCalciteTabsActivate={() => setBerthingSubTab('plan')}>
                    5-Day Plan
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="b-reports" selected={berthingSubTab === 'reports'} onCalciteTabsActivate={() => setBerthingSubTab('reports')}>
                    Terminal Reports
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="b-preberth" selected={berthingSubTab === 'preberth'} onCalciteTabsActivate={() => setBerthingSubTab('preberth')}>
                    Pre-Berthing Board
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="b-upload" selected={berthingSubTab === 'upload'} onCalciteTabsActivate={() => setBerthingSubTab('upload')}>
                    Data Upload
                  </CalciteTabTitle>
                </CalciteTabNav>

                {/* Existing sim/adapter berth-plan gantt — unchanged, and the DEFAULT sub-tab. */}
                <CalciteTab tab="b-plan" selected={berthingSubTab === 'plan'}>
                  <BerthGantt5Day />
                </CalciteTab>

                {/* Spec M-08 / UI-040: the backward-chaining Pre-Berthing Status Board —
                    for a target berthing, everything that must be true and by when. */}
                <CalciteTab tab="b-preberth" selected={berthingSubTab === 'preberth'}>
                  <PreBerthingBoard />
                </CalciteTab>

                {/* New: UC-3 per-terminal berthing REPORT actuals (jnpa.berthing_reports).
                    Keyed on the upload counter so a successful import remounts + refetches. */}
                <CalciteTab tab="b-reports" selected={berthingSubTab === 'reports'}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} key={berthingReportsKey}>
                    <Panel title="Berthing reports — UC-3 backend (jnpa.berthing_reports)" minHeight={120}>
                      <BerthingStats />
                    </Panel>
                    <Panel title="Terminal berthing reports" height={520}>
                      <BerthingReportsTable />
                    </Panel>
                  </div>
                </CalciteTab>

                {/* New: berthing Data Upload (PDF/CSV/XLS/XLSX). On import, bump the key
                    so the Terminal Reports sub-tab refetches. */}
                <CalciteTab tab="b-upload" selected={berthingSubTab === 'upload'}>
                  <BerthingUploadPanel onImported={() => setBerthingReportsKey((k) => k + 1)} />
                </CalciteTab>
              </CalciteTabs>
            </CalciteTab>
            <CalciteTab tab="plan" selected={activeTab === 'plan'}>
              <PlanImportPanel />
            </CalciteTab>
            <CalciteTab tab="dukc" selected={activeTab === 'dukc'}>
              <CalciteTabs layout="inline">
                <CalciteTabNav slot="title-group">
                  <CalciteTabTitle tab="d-analysis" selected={dukcSubTab === 'analysis'} onCalciteTabsActivate={() => setDukcSubTab('analysis')}>
                    DUKC Analysis
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="d-channels" selected={dukcSubTab === 'channels'} onCalciteTabsActivate={() => setDukcSubTab('channels')}>
                    Sea Channels
                  </CalciteTabTitle>
                </CalciteTabNav>

                {/* Existing DUKC / RTUKC view — unchanged, and the DEFAULT sub-tab. */}
                <CalciteTab tab="d-analysis" selected={dukcSubTab === 'analysis'}>
                  <DukcCorridor />
                </CalciteTab>

                {/* Sea-channel section (DUKC domain) — its own nested Data / Upload tabs,
                    same inline style as the Vessels sub-tabs. */}
                <CalciteTab tab="d-channels" selected={dukcSubTab === 'channels'}>
                  <CalciteTabs layout="inline">
                    <CalciteTabNav slot="title-group">
                      <CalciteTabTitle tab="sc-data" selected={seaChannelSubTab === 'data'} onCalciteTabsActivate={() => setSeaChannelSubTab('data')}>
                        Sea Channel Data
                      </CalciteTabTitle>
                      <CalciteTabTitle tab="sc-upload" selected={seaChannelSubTab === 'upload'} onCalciteTabsActivate={() => setSeaChannelSubTab('upload')}>
                        Data Upload
                      </CalciteTabTitle>
                    </CalciteTabNav>

                    {/* Sea-channel register (core.sea_channel) — table only, the DEFAULT. */}
                    <CalciteTab tab="sc-data" selected={seaChannelSubTab === 'data'}>
                      <Panel title="Sea channels — UC-3 backend (core.sea_channel, WGS84 GeoJSON)" height={420}>
                        <SeaChannelTable key={seaChannelUploadKey} />
                      </Panel>
                    </CalciteTab>

                    {/* Sea-channel Data Upload + history. Reuses MarineUploadPanel with a
                        SEA_CHANNEL config; on a successful import it bumps the key above so
                        SeaChannelTable remounts and refetches. */}
                    <CalciteTab tab="sc-upload" selected={seaChannelSubTab === 'upload'}>
                      <MarineUploadPanel
                        title="Sea-channel data upload — validate → import (UC-3 backend)"
                        accept=".zip,.shp,application/zip,application/x-zip-compressed"
                        showTemplate={false}
                        helpText="Accepts the zipped ESRI shapefile bundle (e.g. JNPA_Sea_Channels.zip). The backend detects the format by content and reprojects to WGS84."
                        onImported={() => setSeaChannelUploadKey((k) => k + 1)}
                      />
                    </CalciteTab>
                  </CalciteTabs>
                </CalciteTab>
              </CalciteTabs>
            </CalciteTab>
            <CalciteTab tab="craft" selected={activeTab === 'craft'}>
              <CalciteTabs layout="inline">
                <CalciteTabNav slot="title-group">
                  <CalciteTabTitle tab="pc-list" selected={craftSubTab === 'list'} onCalciteTabsActivate={() => setCraftSubTab('list')}>
                    Port Craft List
                  </CalciteTabTitle>
                  <CalciteTabTitle tab="pc-upload" selected={craftSubTab === 'upload'} onCalciteTabsActivate={() => setCraftSubTab('upload')}>
                    Data Upload
                  </CalciteTabTitle>
                </CalciteTabNav>

                {/* Existing craft content — unchanged, and the DEFAULT sub-tab. */}
                <CalciteTab tab="pc-list" selected={craftSubTab === 'list'}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Existing live-ops board (mock/adapter) — unchanged. */}
                    <PortCraftBoard />
                    {/* Spec UI-039 (screen M-07): pilot board→all-fast as a DISTRIBUTION
                        (median · P90 per pilot) from the ingested pilot cards. */}
                    <Panel title="Pilot performance — board → all fast (median · P90)" minHeight={260}>
                      <PilotPerformancePanel />
                    </Panel>
                    {/* Utilisation/response strip — previously built, never mounted (D9). */}
                    <Panel title="Craft utilisation & response" minHeight={240}>
                      <PortCraftPerformance />
                    </Panel>
                    {/* UC-3 fleet register (core.port_craft) from the client PDF. */}
                    <Panel title="Port-craft fleet register — UC-3 backend (core.port_craft)" height={420}>
                      <PortCraftRegisterTable key={portCraftUploadKey} />
                    </Panel>
                  </div>
                </CalciteTab>

                {/* Port-craft Data Upload + history. Reuses MarineUploadPanel with a
                    PORT_CRAFT (PDF) config; on a successful import it bumps the key above
                    so PortCraftRegisterTable remounts and refetches. */}
                <CalciteTab tab="pc-upload" selected={craftSubTab === 'upload'}>
                  <MarineUploadPanel
                    title="Port-craft data upload — validate → import (UC-3 backend)"
                    accept=".pdf,application/pdf"
                    showTemplate={false}
                    helpText="Accepts the port-craft register PDF (e.g. Details_of_Port_Crafts.pdf). The backend detects the format by content."
                    onImported={() => setPortCraftUploadKey((k) => k + 1)}
                  />
                </CalciteTab>
              </CalciteTabs>
            </CalciteTab>
            <CalciteTab tab="scenarios" selected={activeTab === 'scenarios'}>
              <Scenarios />
            </CalciteTab>
            <CalciteTab tab="workflows" selected={activeTab === 'workflows'}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16, alignItems: 'start' }}>
                <div>
                  <h3 style={{ fontSize: 13, color: tokens.textMuted, margin: '0 0 8px' }}>Workflow composer</h3>
                  <WorkflowComposer />
                </div>
                <div>
                  <h3 style={{ fontSize: 13, color: tokens.textMuted, margin: '0 0 8px' }}>Automated-workflow ledger</h3>
                  <WorkflowRuns />
                </div>
              </div>
            </CalciteTab>
            <CalciteTab tab="analytics" selected={activeTab === 'analytics'}>
              <AnalyticsPanel />
            </CalciteTab>
            <CalciteTab tab="connectors" selected={activeTab === 'connectors'}>
              <ConnectorReadiness />
            </CalciteTab>
            <CalciteTab tab="reports" selected={activeTab === 'reports'}>
              <ExportToolbar />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
                <Panel title="Arrivals & Departures (4h blocks)" minHeight={260}>
                  <ArrivalsDepartures />
                </Panel>
                <Panel title="Weather & Sea-State" minHeight={260}>
                  <WeatherPanel />
                </Panel>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Panel title="Live Vessel Feed (priority order)" height={360}>
                    <VesselFeed />
                  </Panel>
                </div>
              </div>
            </CalciteTab>
            <CalciteTab tab="methodology" selected={activeTab === 'methodology'}>
              <MethodologyPanel />
            </CalciteTab>
          </CalciteTabs>
        </CalcitePanel>
      </CalciteShell>

      {/* Overlays: guided tour narrates a scenario; reactive guide shows its
          causal chain; the integration console injects per-source faults. */}
      <GuidedTour onStep={onTourStep} />
      <ReactiveGuide onSpotlight={(ids) => useSimStore.getState().setHighlights(ids)} />
      <IntegrationConsole />
    </>
  );
}
