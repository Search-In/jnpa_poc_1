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
import { PortScene, type PortSceneHandle, type CameraPreset } from '@/map/PortScene';
import { DemoPlayer } from '@/sim/DemoPlayer';
import { SimControls } from '@/sim/SimControls';
import { PlacementToolbar } from '@/map/PlacementToolbar';
import { Panel } from '@/components/common/Panel';
import { BerthGantt5Day } from '@/components/reports/BerthGantt5Day';
import { PlanImportPanel } from '@/planning/PlanImportPanel';
import { ArrivalsDepartures } from '@/components/reports/ArrivalsDepartures';
import { JustInTime } from '@/components/reports/JustInTime';
import { DelayTrend } from '@/components/reports/DelayTrend';
import { PortCraftBoard } from '@/components/reports/PortCraftBoard';
import { PredictionConvergence } from '@/components/reports/PredictionConvergence';
import { DukcCorridor } from '@/components/reports/DukcCorridor';
import { WeatherPanel } from '@/components/WeatherPanel';
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
  const [activeTab, setActiveTab] = useState<TabId>('kpis');
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
              </div>
            </CalciteTab>

            <CalciteTab tab="vessels" selected={activeTab === 'vessels'}>
              <Panel title="All vessels — live AIS feed" height={640}>
                <VesselTable />
              </Panel>
            </CalciteTab>

            <CalciteTab tab="gantt" selected={activeTab === 'gantt'}>
              <BerthGantt5Day />
            </CalciteTab>
            <CalciteTab tab="plan" selected={activeTab === 'plan'}>
              <PlanImportPanel />
            </CalciteTab>
            <CalciteTab tab="dukc" selected={activeTab === 'dukc'}>
              <DukcCorridor />
            </CalciteTab>
            <CalciteTab tab="craft" selected={activeTab === 'craft'}>
              <PortCraftBoard />
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
